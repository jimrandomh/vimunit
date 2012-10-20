set nocompatible
set undolevels=50
set shortmess=ats
set ts=4
set sw=4

let totalSuccesses = 0
let totalFailures = 0

function Main()
	let testFiles = GetTestFiles()
	call RunTestFiles(testFiles)
	
	call LogTest("OVERALL: " . g:totalSuccesses . " succeeded, " . g:totalFailures . " failed\n")

	let logText = join(g:logLines, "\n")
	let logLines = split(logText, "\n")
	call writefile(logLines, 'testresults.txt')
	:q!
endfunction

function GetTestFiles()
	return split(glob("./**/*.vimunit"), "\n")
endfunction

function RunTestFiles(files)
	for file in a:files
		call RunTestFile(file)
	endfor
endfunction

function RunTestFile(filename)
	let contents = readfile(a:filename)
	let ii = 0
	let testStart = -1
	let successes = 0
	let failures = 0
	
	while ii < len(contents)
		if contents[ii] =~ '^:start.*'
			let testStart = ii
		elseif contents[ii] =~ '^:end.*'
			if testStart < 0
				echoerr a:filename.':' . ii . ': Invalid test case definition: mismatched :end'
			else
				let testDescription = substitute(contents[testStart], '^:start\s*\(.*\)$', '\1', '')
				let testLines = contents[testStart+1:ii-1]
				call LogTest(testDescription)
				if RunTest(a:filename, testDescription, testStart+1, testLines)
					let successes = successes+1
					let g:totalSuccesses = g:totalSuccesses+1
				else
					let failures = failures+1
					let g:totalFailures = g:totalFailures+1
				endif
				let testStart = -1
			endif
		endif
		let ii = ii+1
	endwhile
	
	call LogTest(a:filename . ": " . successes . " succeeded, " . failures . " failed\n")
	
	" Clear the buffer
	:%d
endfunction

function RunTest(filename, description, firstLine, lines)
	let ii = 0
	let bufStart = 0
	let wasSuccessful = 1
	
	while ii < len(a:lines)
		if a:lines[ii] =~ '^:.*'
			if bufStart == 0
				call InitBuffer(GetBufferLines(a:lines, 0, ii-1))
			else
				if !ExpectBuffer(a:filename, a:firstLine+bufStart, GetBufferLines(a:lines, bufStart, ii-1))
					let wasSuccessful = 0
					call InitBuffer(GetBufferLines(a:lines, bufStart, ii-1))
				endif
			endif
			let bufStart = ii+1
			if a:lines[ii] =~ '^:type.*'
				let keys = substitute(a:lines[ii], '^:type\s*\(.*\)$', '\1', '')
				call HandleKeys(keys)
			else
				echoerr a:filename.':'.(a:firstLine+ii).': Unrecognized directive'
				return 0
			endif
		endif
		let ii = ii+1
	endwhile
	if !ExpectBuffer(a:filename, a:firstLine+bufStart, GetBufferLines(a:lines, bufStart, len(a:lines)))
		let wasSuccessful = 0
	endif
	return wasSuccessful
endfunction

function GetBufferLines(lines, start, end)
	return map(a:lines[a:start : a:end], 'substitute(v:val, "^\t", "", "")')
endfunction

function HandleKeys(keys)
	" Split into multiple undo entries
	let savedCursor = getpos('.')
	silent :undo
	silent :redo
	call setpos('.', savedCursor)
	
	" Run commands
	silent execute ("normal ".UnescapeKeys(a:keys))
endfunction

function UnescapeKeys(keys)
	return eval('"'.substitute(a:keys, '"', '\"', 'g').'"')
endfunction

function InitBuffer(lines)
	" Clear the buffer
	:%d
	
	" Add lines. When a '|' is found, remove it but put the cursor there.
	let ii=0
	while ii < len(a:lines)
		let line = a:lines[ii]
		if line =~ '|'
			let line = substitute(line, '|', '', '')
			call setline(ii+1, line)
			call setpos('.', [0, ii+1, 1+stridx(a:lines[ii], '|'), 0])
		else
			call setline(ii+1, a:lines[ii])
		endif
		let ii = ii+1
	endwhile
endfunction

function ExpectBuffer(filename, firstLineNumber, lines)
	let actual = GetCurrentBufferContents()
	let expected = join(a:lines, "\n")
	
	if actual != expected
		call LogTest(a:filename.":".(a:firstLineNumber+1).": Text doesn't match")
		call LogTest("Expected:\n".expected)
		call LogTest("Actual:\n".actual)
		return 0
	endif

	return 1
endfunction

function GetCurrentBufferContents()
	let lines = getline(0,'$')
	let cursorLine = line('.') - 1
	let cursorCol = col('.') - 1
	let cursorLineText = lines[cursorLine]
	
	let prefix = ""
	if cursorCol > 0
		let prefix = cursorLineText[0 : (cursorCol-1)]
	endif
	let suffix = cursorLineText[cursorCol :]
	let lines[cursorLine] = prefix . '|' . suffix
	
	return join(lines, "\n")
endfunction

let logLines = []

function LogTest(message)
	call add(g:logLines, a:message)
endfunction

call Main()

