#!/bin/bash

rm -f testresults.txt
vim -u runtest.vim >/dev/null 0>&1 2>&1
cat testresults.txt
