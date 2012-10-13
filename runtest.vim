
function RunTestFile(filename)
	let contents = readfile(a:filename)
	let ii = 0
	let test_start = -1
	while ii < len(contents)
		if contents[ii] =~ '^:start.*'
			let test_start = ii
		elseif contents[ii] =~ '^:end.*'
			if test_start < 0
				echoerr filename.':' . ii . ': Invalid test case definition: mismatched :end'
			else
				let testDescription = substitute(contents[test_start], '^:start\s*\(.*\)$', '\1', '')
				let testLines = contents[test_start+1:ii-1]
				call RunTest(a:filename, testDescription, test_start+1, testLines)
				let test_start = -1
			endif
		endif
		let ii = ii+1
	endwhile
endfunction

function RunTest(filename, description, firstLine, lines)
	let ii = 0
	let bufStart = 0
	while ii < len(a:lines)
		if a:lines[ii] =~ '^:.*'
			if bufStart == 0
				call InitBuffer(a:lines[0:ii])
			else
				call ExpectBuffer(a:firstLine+bufStart, lines[bufStart:ii])
			endif
			let bufStart = ii+1
			if a:lines[ii] =~ '^:type.*'
				let keys = substitute(a:lines[ii], '^:type\s*\(.*\)$', '\1', '')
				call HandleKeys(keys)
			else
				echoerr filename.':'.(a:firstLine+ii).': Unrecognized directive'
				return 0
			endif
		endif
		let ii = ii+1
	endwhile
	call ExpectBuffer(a:firstLine+bufStart, a:lines[bufStart : len(a:lines)])
	return 1
endfunction

function HandleKeys(keys)
	" TODO
endfunction

function InitBuffer(lines)
	" TODO
endfunction

function ExpectBuffer(firstLineNumber, lines)
	" TODO
endfunction

function Main(args)
	for arg in a:args
		if arg =~ '^-.*'
			echoerr 'Unrecognized option: ' . arg
		else
			call RunTestFile(arg)
		endif
	endfor
endfunction

call Main(argv())

