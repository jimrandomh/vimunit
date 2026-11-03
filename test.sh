#!/bin/bash
# Run the suite against vim (the reference implementation) and save the report.
# For more options (neovim, parallelism, filtering), see ./vimunit run --help.
cd "$(dirname "$0")"
mkdir -p out
exec ./vimunit run --log out/testresults-vim.txt "$@"
