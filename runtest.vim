
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
				if RunTest(a:filename, testDescription, testStart+1, testLines)
					let successes = successes+1
					call LogTest(testDescription . ': ok')
				else
					let failures = failures+1
					call LogTest(testDescription . ': FAILED')
				endif
				let testStart = -1
			endif
		endif
		let ii = ii+1
	endwhile
	
	call LogTest(a:filename . ': ' . successes . ' succeeded, ' . failures . ' failed')
	
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
				call InitBuffer(a:lines[0:ii-1])
			else
				if !ExpectBuffer(a:filename, a:firstLine+bufStart, a:lines[bufStart : ii-1])
					let wasSuccessful = 0
					call InitBuffer(a:lines[bufStart : ii])
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
	if !ExpectBuffer(a:filename, a:firstLine+bufStart, a:lines[bufStart : len(a:lines)])
		let wasSuccessful = 0
	endif
	return wasSuccessful
endfunction

function HandleKeys(keys)
	"call feedkeys(a:keys, 't')
	:execute ("normal ".a:keys)
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
	let ii=0
	let cursorLine = -1
	let cursorCol = -1
	
	while ii < len(a:lines)
		let line = a:lines[ii]
		if line =~ '|'
			let cursorCol = stridx(line, '|')+1
			let cursorLine = ii+1
			let line = substitute(line, '|', '', '')
		endif
		if getline(ii+1) != line
			call LogTest(a:filename.":".(a:firstLineNumber+ii).": Text doesn't match")
			call LogTest("    Expected: " . line)
			call LogTest("    Actual: " . getline(ii+1))
			return 0
		endif
		let ii = ii+1
	endwhile
	
	if cursorLine >= 1
		if col('.') != cursorCol || line('.') != cursorLine
			call LogTest(a:filename.":".(a:firstLineNumber+ii).": Wrong cursor position")
			call LogTest("    Expected: " . cursorLine . "," . cursorCol)
			call LogTest("    Actual: " . line('.') . "," . col('.'))
			return 0
		endif
	endif
	
	" Check buffer for extra lines
	let lastLine = line('$')
	if lastLine != len(a:lines)
		call LogTest(a:filename.":".(a:firstLineNumber+len(a:lines)).": extra lines at end of buffer")
		return 0
	endif
	return 1
endfunction

let logLines = []

function LogTest(message)
	call add(g:logLines, a:message)
endfunction

function Main(args)
	for arg in a:args
		if arg =~ '^-.*'
			echoerr 'Unrecognized option: ' . arg
		else
			call RunTestFile(arg)
		endif
	endfor

	echomsg 'Test results'
	for message in g:logLines
		echomsg message
	endfor
	:q!
endfunction

call Main(['tests/motions.vimunit'])

