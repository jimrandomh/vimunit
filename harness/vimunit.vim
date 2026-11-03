" vim-unit reference harness.
"
" Runs a JSON test spec (produced by the `vimunit` script) inside Vim or
" Neovim and appends one JSON record per test step to an output file. This
" file is not meant to be used directly; run `./vimunit run` instead.
"
" Inputs (set with --cmd before this file is sourced):
"   g:vimunit_spec   path of the JSON spec
"   g:vimunit_out    path of the JSON-lines output file
"   g:vimunit_dir    scratch directory for per-test files
"   g:vimunit_start  index of the first test to run (default 0)
"
" Keys are typed the way a person types them: one at a time, each only after
" the editor has completely processed the previous one and is waiting for
" input. (Queueing a step's keys all at once is subtly different: with
" typeahead pending, Vim inserts text in one piece, which moves the '. mark,
" doesn't show the completion menu, and peeks at keys after commands like f.)
" Because the keys are typed, an error or bell does not discard the remaining
" keys of the step, but does abort a running macro, just as interactively.
" When the last key has been processed, the step is over.
"
" In Vim, a timer fires whenever the editor waits for input, including in the
" middle of a command (after a count, an operator, `r`), so it can type the
" next key. Neovim only runs timers when idle in a "safe" state, so it also
" uses a libuv timer, which runs while Neovim is blocked waiting for the rest
" of a command, and counts consumed keys with vim.on_key().

if !has('nvim')
  set encoding=utf-8
endif
scriptencoding utf-8
set nocompatible

let s:spec = json_decode(join(readfile(g:vimunit_spec), "\n"))
let s:tests = s:spec.tests
let s:ti = get(g:, 'vimunit_start', 0)
let s:si = 0
let s:pending = 0
let s:keys = []
let s:ki = 0
let s:cur_lines = -1
let s:cur_columns = -1
let s:resync = {}

function! s:Emit(rec) abort
  call writefile([json_encode(a:rec)], g:vimunit_out, 'a')
endfunction

" ---------------------------------------------------------------------------
" One-time setup

function! s:GlobalSetup() abort
  " Never stop to wait for the user after a message.
  if exists('+messagesopt')
    set messagesopt=wait:0,history:500
  endif
  set nomore
  set belloff=all
  set noswapfile
  set laststatus=0 cmdheight=1
  set noshowcmd noruler noshowmode
  set shortmess+=I
  set hidden
  filetype off
  syntax off
  " Neovim creates default mappings (Y, &, Q, gc, [d, ...); remove them so
  " both editors start from Vim's built-in command set.
  mapclear
  mapclear!
  if exists(':tmapclear') == 2
    tmapclear
  endif
  if has('nvim')
    lua VimunitNvim.init()
    call timer_start(1, {-> luaeval('VimunitNvim.tick()')}, {'repeat': -1})
  else
    call timer_start(1, 'VimunitTick', {'repeat': -1})
  endif
endfunction

" ---------------------------------------------------------------------------
" Per-test setup

function! s:ClearGlobalState() abort
  for r in split('abcdefghijklmnopqrstuvwxyz0123456789-', '\zs')
    call setreg(r, [])
  endfor
  call setreg('"', [])
  let @/ = ''
  let v:searchforward = 1
  silent! nohlsearch
  call setcharsearch({'char': '', 'forward': 1, 'until': 0})
  for h in [':', '/', '=', '@', '>']
    call histdel(h)
  endfor
  silent! delmarks A-Z0-9
  call settagstack(win_getid(), {'items': []}, 'r')
endfunction

function! s:SetWindowSize(width, height) abort
  if a:width != s:cur_columns
    let &columns = a:width
    let s:cur_columns = a:width
  endif
  " The text area is 'lines' minus the command line (no status line).
  if a:height + 1 != s:cur_lines
    let &lines = a:height + 1
    let s:cur_lines = a:height + 1
  endif
endfunction

function! s:ApplyOptions(options) abort
  for [l:name, l:value] in items(a:options)
    if exists('+' . l:name)
      execute 'let &' . l:name . ' = l:value'
    endif
  endfor
endfunction

function! s:SetupTest(test) abort
  silent! only!
  call s:ClearGlobalState()

  " Load the initial text as a fresh file, so that undo history, the change
  " list and buffer-local marks are empty, exactly as when opening a file.
  let l:old = bufnr('%')
  let l:file = g:vimunit_dir . '/test' . s:ti . '.txt'
  call writefile(a:test.initial.lines, l:file)
  execute 'silent edit! ' . fnameescape(l:file)
  if bufnr('%') != l:old && bufexists(l:old)
    execute 'silent! bwipeout! ' . l:old
  endif

  call s:SetWindowSize(a:test.window[0], a:test.window[1])
  call s:ApplyOptions(a:test.options)
  setlocal tagfunc=VimunitTagfunc
  normal! zX

  call cursor(a:test.initial.cursor[0], a:test.initial.cursor[1])
  call winrestview({'topline': 1, 'leftcol': 0})
  clearjumps
endfunction

" Overwrite the buffer with an expected state (used to resynchronize after a
" step whose result was wrong, so later steps can still be checked).
function! s:SetBuffer(state) abort
  call setline(1, a:state.lines)
  if line('$') > len(a:state.lines)
    silent call deletebufline('%', len(a:state.lines) + 1, '$')
  endif
  call cursor(a:state.cursor[0], a:state.cursor[1])
endfunction

" ---------------------------------------------------------------------------
" Running steps

" A key token ('x', '<Esc>', '<C-V>') as the string feedkeys() takes.
function! s:KeyString(token) abort
  if strchars(a:token) > 1 && a:token[0] ==# '<'
    return eval('"\' . a:token . '"')
  endif
  return a:token
endfunction

function! s:StartStep() abort
  let l:test = s:tests[s:ti]
  if s:si == 0
    try
      call s:SetupTest(l:test)
    catch
      call s:Emit({'t': s:ti, 'setup_error': v:exception})
      let s:ti += 1
      let s:si = 0
      call s:Continue()
      return
    endtry
  endif
  let v:errmsg = ''
  let s:pending = 1
  if has('nvim')
    call luaeval('VimunitNvim.start(_A)', l:test.steps[s:si].keys)
  else
    let s:keys = map(copy(l:test.steps[s:si].keys), {_, t -> s:KeyString(t)})
    let s:ki = 0
  endif
endfunction

" Vim: called by a timer, which only fires while Vim waits for input, so each
" call means the previous key has been completely processed. getchar(1)
" guards against firing with keys still queued.
function! VimunitTick(timer) abort
  if !s:pending || getchar(1)
    return
  endif
  if s:ki < len(s:keys)
    call feedkeys(s:keys[s:ki], 'nt')
    let s:ki += 1
  else
    call VimunitFinishStep(mode(1))
  endif
endfunction

" Record the state at the end of a step, and move on to the next one.
" `mode` is the mode the keys left the editor in.
function! VimunitFinishStep(mode) abort
  let s:pending = 0
  call s:Emit({
        \ 't': s:ti,
        \ 's': s:si,
        \ 'lines': getline(1, '$'),
        \ 'cursor': [line('.'), col('.')],
        \ 'mode': a:mode,
        \ 'recording': reg_recording(),
        \ 'errmsg': v:errmsg,
        \ })

  " Get back to Normal mode. In Normal mode, <Esc> also cancels anything left
  " waiting for an argument (like a trailing `r`).
  let l:prefix = mode(1) ==# 'n' ? "\<Esc>" : "\<C-\>\<C-N>"
  if reg_recording() !=# ''
    let l:prefix .= 'q'
  endif

  " Resynchronize to the expected state if this step went wrong.
  let l:expected = s:tests[s:ti].steps[s:si].expected
  let s:resync = type(l:expected) == v:t_dict
        \ && (getline(1, '$') != l:expected.lines || [line('.'), col('.')] != l:expected.cursor)
        \ ? l:expected : {}

  let s:si += 1
  if s:si >= len(s:tests[s:ti].steps)
    let s:ti += 1
    let s:si = 0
  endif
  call feedkeys(l:prefix . "\<Cmd>call VimunitNext()\<CR>", 'nt')
endfunction

function! VimunitNext() abort
  if s:si > 0 && !empty(s:resync)
    call s:SetBuffer(s:resync)
  endif
  let s:resync = {}
  call s:Continue()
endfunction

function! s:Continue() abort
  if s:ti >= len(s:tests)
    call s:Emit({'done': 1})
    qall!
  endif
  call s:StartStep()
endfunction

if has('nvim')
lua << LUA
VimunitNvim = {}
local st = {keys = {}, ki = 0, fed = 0, consumed = 0, pending = false, forced_mode = nil}

local function feed()
  st.ki = st.ki + 1
  st.fed = st.fed + 1
  local k = st.keys[st.ki]
  vim.api.nvim_input(k == '<' and '<lt>' or k)
end

function VimunitNvim.init()
  vim.on_key(function()
    if st.pending then st.consumed = st.consumed + 1 end
  end)
  -- Runs even while Neovim is blocked in the middle of a command.
  local t = vim.uv.new_timer()
  t:start(1, 1, function()
    if not st.pending or st.consumed < st.fed then return end
    local m = vim.api.nvim_get_mode()
    if not m.blocking then return end
    if st.ki < #st.keys then
      feed()
    elseif not st.forced_mode then
      -- The keys ended in the middle of a command. Note the mode, and get
      -- back to a state where the main-loop timer can finish the step.
      st.forced_mode = m.mode
      vim.api.nvim_input(m.mode == 'n' and '<Esc>' or '<C-\\><C-N>')
    end
  end)
end

function VimunitNvim.start(keys)
  st.keys, st.ki, st.fed, st.consumed, st.forced_mode = keys, 0, 0, 0, nil
  st.pending = true
end

-- Runs from a main-loop timer, only while Neovim is idle in a safe state.
function VimunitNvim.tick()
  if not st.pending or st.consumed < st.fed then return end
  if st.ki < #st.keys then
    feed()
  else
    st.pending = false
    vim.fn.VimunitFinishStep(st.forced_mode or vim.fn.mode(1))
  end
end
LUA
endif

" ---------------------------------------------------------------------------
" Definitions metadata (:definition directives), exposed through 'tagfunc' so
" that CTRL-], :tag, CTRL-T and friends work.

function! VimunitTagfunc(pattern, flags, info) abort
  if a:flags =~# 'i'
    return v:null
  endif
  let l:result = []
  for l:d in get(s:tests[s:ti], 'definitions', [])
    if (a:flags =~# 'r' && l:d.name =~# a:pattern) || l:d.name ==# a:pattern
      call add(l:result, {
            \ 'name': l:d.name,
            \ 'filename': expand('%:p'),
            \ 'cmd': '/\%' . l:d.line . 'l\%' . l:d.col . 'c/',
            \ })
    endif
  endfor
  return l:result
endfunction

call s:GlobalSetup()
call s:Continue()
