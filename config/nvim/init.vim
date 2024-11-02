set runtimepath+=~/.vim,~/.vim/after
set packpath+=~/.vim

set inccommand=nosplit

source ~/.vimrc

lua << EOF
require('orgmode').setup({
  org_agenda_files = {'~/org/*'},
  org_default_notes_file = '~/org/Inbox.org',
})
EOF

" lua << EOF
" require("config.lazy")
" EOF
