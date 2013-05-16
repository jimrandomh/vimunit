set nocompatible
set undolevels=50
set shortmess=ats
set ts=4
set sw=4

let totalSuccesses = 0
let totalFailures = 0

let tests = []
let currentTest = 0

function Main()
	let testFiles = GetTestFiles()
	call LoadTestFiles(testFiles)
	call SetBufferContents(g:tests[0]["before"])
	call RunNextTest()
endfunction

function OnFinish()
	call LogTest("Succeeded: " . g:totalSuccesses)
	call LogTest("Failed: " . g:totalFailures)
	call SaveLogAs("testresults.txt")
	":q!
endfunction

function GetTestFiles()
	return split(glob("./**/*.vimunit"), "\n")
endfunction

function LoadTestFiles(files)
	for file in a:files
		call LoadTestFile(file)
	endfor
endfunction

function LoadTestFile(filename)
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
				
				call LoadTest(a:filename, testDescription, testStart+1, testLines)
				let testStart = -1
			endif
		endif
		let ii = ii+1
	endwhile
endfunction

function LoadTest(filename, description, firstLine, lines)
	let ii = 0
	let bufStart = 0
	let wasSuccessful = 1
	let expectedBuffers = []
	let typedKeys = []
	
	while ii < len(a:lines)
		if a:lines[ii] =~ '^:.*'
			if bufStart == 0
				let expectedBuffers += [{"lines": ParseTestDescriptionLines(a:lines, 0, ii-1), "firstLine": a:firstLine+1}]
			else
				"if !ExpectBuffer(a:filename, a:firstLine+bufStart, ParseTestDescriptionLines(a:lines, bufStart, ii-1))
				let expectedBuffers += [{"lines": ParseTestDescriptionLines(a:lines, bufStart, ii-1), "firstLine": a:firstLine+bufStart+1}]
			endif
			let bufStart = ii+1
			if a:lines[ii] =~ '^:type.*'
				let keys = ParseTypeKeysLine(a:lines[ii])
				let typedKeys += [keys]
			else
				echoerr a:filename.":".(a:firstLine+ii).": Unrecognized directive"
				return 0
			endif
		endif
		let ii += 1
	endwhile
	let expectedBuffers += [{"lines": ParseTestDescriptionLines(a:lines, bufStart, len(a:lines)), "firstLine": a:firstLine+bufStart}]
	
	let ii = 0
	while ii < len(typedKeys)
		let before = expectedBuffers[ii]["lines"]
		let after = expectedBuffers[ii+1]["lines"]
		let test = {"filename": a:filename, "description": a:description, "firstLine": expectedBuffers[ii+1]["firstLine"], "before": before, "after": after, "keys": typedKeys[ii]}
		let g:tests += [test]
		let ii += 1
	endwhile
endfunction

function ParseTypeKeysLine(line)
	let keystr = substitute(a:line, '^:type\s*\(.*\)$', '\1', "")
	let gtstr = substitute(substitute(keystr, "\<GT>", ">", "g"), "\<LT>", "<", "g")
	let unescaped = eval('"'.substitute(gtstr, '"', '\\"', "g").'"')
	return unescaped
endfunction

function ParseTestDescriptionLines(lines, start, end)
	let unindentedLines = map(a:lines[a:start : a:end], 'substitute(v:val, "^\t", "", "")')
	return join(unindentedLines, "\n")
endfunction

function RunNextTest()
	if g:currentTest > 0
		let prevTest = g:tests[g:currentTest-1]
		call CheckTestResult(prevTest)
	endif
	
	if g:currentTest >= len(g:tests)
		call OnFinish()
		return 0
	endif

	let test = g:tests[g:currentTest]
	call RunTest(test)
	let g:currentTest += 1
endfunction


function CheckTestResult(test)
	let result = GetCurrentBufferContents()
	if result != a:test["after"]
		call LogTest(a:test["filename"].":".(a:test["firstLine"]).": Text doesn't match")
		call LogTest("Expected:\n" . IndentString(a:test["after"]))
		call LogTest("Actual:\n" . IndentString(result))
		call LogTest("\n")
		let g:totalFailures += 1
	else
		let g:totalSuccesses += 1
	endif
endfunction

function RunTest(test)
	if GetCurrentBufferContents() != a:test["before"]
		call SetBufferContents(a:test["before"])
	endif
	
	call feedkeys(a:test["keys"], "t")
	call feedkeys("\<esc>:call RunNextTest()\n", "t")
endfunction


function SetBufferContents(text)
	" Clear the buffer
	:%d
	
	" Add lines. When a '|' is found, remove it but put the cursor there.
	let lines = split(a:text, "\n")
	let ii=0
	while ii < len(lines)
		let line = lines[ii]
		if line =~ '|'
			let line = substitute(line, '|', '', '')
			call setline(ii+1, line)
			call setpos('.', [0, ii+1, 1+stridx(lines[ii], '|'), 0])
		else
			call setline(ii+1, lines[ii])
		endif
		let ii = ii+1
	endwhile
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

function IndentString(str)
	let lines = split(a:str, "\n")
	let indentedLines = map(lines, '"\t" . v:val')
	return join(indentedLines, "\n")
endfunction


let logLines = []

function LogTest(message)
	call add(g:logLines, a:message)
endfunction

function SaveLogAs(filename)
	let logText = join(g:logLines, "\n")
	let logLines = split(logText, "\n")
	call writefile(logLines, a:filename)
endfunction


call Main()
