let mapleader = "\<Space>"

" Load matchit.vim, but only if the user hasn't installed a newer version.
if !exists('g:loaded_matchit') && findfile('plugin/matchit.vim', &rtp) ==# ''
  runtime! macros/matchit.vim
endif

syntax on
filetype plugin indent on

" When the type of shell script is /bin/sh, assume a POSIX-compatible
" shell for syntax highlighting purposes.
let g:is_posix = 1

" Softtabs, 2 spaces
set tabstop=2
set shiftwidth=2
set shiftround
set expandtab

" Display extra whitespace
set list listchars=tab:»·,trail:·,nbsp:·

" Use one space, not two, after punctuation.
set nojoinspaces

if executable('rg')
  set grepprg=rg\ --glob=!.git\ --hidden\ --vimgrep\ --smart-case\ $*
  set grepformat=%f:%l:%c:%m
endif

set number

" Open new split panes to right and bottom, which feels more natural
set splitbelow
set splitright

" Core {{{

" Allow project specific vimrc
set exrc

" Optimize for fast terminal connections
set ttyfast

" Use UTF-8 without BOM
set encoding=utf-8 nobomb

" Respect modeline in files
set modeline
set modelines=4

" Don’t reset cursor to start of line when moving around.
set nostartofline

" UI
set autoread
set colorcolumn=81
set cursorline
set hidden
set textwidth=0
set backspace=2   " Backspace deletes like most programs in insert mode
set nobackup
set nowritebackup
set noswapfile    " http://robots.thoughtbot.com/post/18739402579/global-gitignore#comment-458413287
set history=50
set ruler         " show the cursor position all the time
set showcmd       " display incomplete commands
set incsearch     " do incremental searching
set laststatus=2  " Always display the status line
set autowrite     " Automatically :write before running commands
set smartindent
set breakindent
let &showbreak = '→ '
set linebreak
set hlsearch
set ignorecase  " searches are case insensitive...
set smartcase   " ... unless they contain at least one capital letter
set infercase   " Use the correct case when autocompleting
set mouse=a " Enable mouse in all modes
set updatetime=100
set fillchars=eob:\ ,stl:─,vert:│

" fix & command to preserve flags
nnoremap & :&&<CR>
xnoremap & :&&<CR>

" Expand %% to current directory
cnoremap %% <C-R>=fnameescape(expand('%:h')).'/'<cr>

" automatically rebalance windows on vim resize
autocmd VimResized * wincmd =
set nofoldenable       " don't fold by default

" Persistent undo
let undodir = expand('~/.vim/undo')
if !isdirectory(undodir)
  call mkdir(undodir)
endif
set undodir=~/.vim/undo
set undofile

nnoremap \ :grep<SPACE>
nnoremap gr :grep! "\b<cword>\b"<CR>:cw<CR><CR>

augroup quickfix
  autocmd!
  autocmd QuickFixCmdPost [^l]* cwindow
  autocmd QuickFixCmdPost l* lwindow
augroup END

hi VertSplit guibg=NONE

highlight htmlArg cterm=italic gui=italic
highlight Comment cterm=italic gui=italic
highlight Type    cterm=italic gui=italic

let theme_script_path = expand("~/.local/share/tinted-theming/tinty/base16-vim-colors-file.vim")

function! FileExists(file_path)
  return filereadable(a:file_path) == 1
endfunction

function! HandleFocusGained()
  if FileExists(g:theme_script_path)
    execute 'source ' . g:theme_script_path
  endif
endfunction

if FileExists(theme_script_path)
  set termguicolors
  let g:tinted_colorspace = 256
  execute 'source ' . theme_script_path
  " TODO: tmux isn't handling this correctly
  " autocmd FocusGained * call HandleFocusGained()
endif
" }}}

" Mappings {{{
" Originally from vim-sensible, but <C-L> is used for TmuxNavigate
" Use <leader><C-L> to clear the highlighting of :set hlsearch.
nnoremap <silent> <leader><C-L> :nohlsearch<C-R>=has('diff')?'<Bar>diffupdate':''<CR><CR><C-L>

nnoremap <silent><Leader>] <C-w><C-]><C-w>T

vnoremap <Leader>y "+y
vnoremap <Leader>p "+p

nnoremap <Leader>y "+y
nnoremap <Leader>p "+p
nnoremap <Leader>P "+P
" }}}

" Plugins {{{
" airline
let g:airline_theme = 'base16_ocean'
let g:airline#extensions#scrollbar#enabled = 1
let g:airline#extensions#tabline#enabled = 1
let g:airline#extensions#tabline#show_buffers = 0
let g:airline#extensions#tabline#show_tab_type = 0
let g:airline#extensions#tabline#show_close_button = 0
let g:airline_powerline_fonts = 1

" ale
let g:ale_completion_autoimport = 1
let g:ale_completion_enabled = 1
let g:ale_echo_msg_error_str = ''
let g:ale_echo_msg_format = '[%linter%] %s [%severity%]'
let g:ale_echo_msg_warning_str = ''
let g:ale_floating_preview = 1
let g:ale_floating_window_border = ['│', '─', '╭', '╮', '╯', '╰']
let g:ale_hover_cursor = 0
let g:ale_linters_explicit = 1

let g:ale_ruby_sorbet_enable_watchman = 1
let g:ale_vim_vimls_use_global = 1

highlight link ALEError Error

nnoremap <Leader>af :ALEFix<CR>

function ALETagFunc(pattern, flags, info) abort
  if a:flags != "c"
    return v:null
  endif

  let l:current_tag = expand("<cWORD>")

  " execute("call CocAction('jumpDefinition')")
  " let filename = expand('%:p')
  " let cursor_pos = getpos(".")
  " let cmd = '/\%'.cursor_pos[1].'l\%'.cursor_pos[2].'c/'
  " execute("normal \<C-o>")
  " return [ { 'name': name, 'filename': filename, 'cmd': cmd } ]
  return []
endfunction

" function! s:gotoDefinition() abort
"   let l:current_tag = expand('<cWORD>')
"
"   let l:current_position    = getcurpos()
"   let l:current_position[0] = bufnr()
"
"   let l:current_tag_stack = gettagstack()
"   let l:current_tag_index = l:current_tag_stack['curidx']
"   let l:current_tag_items = l:current_tag_stack['items']
"
"   if CocAction('jumpDefinition')
"     let l:new_tag_index = l:current_tag_index + 1
"     let l:new_tag_item = [#{tagname: l:current_tag, from: l:current_position}]
"     let l:new_tag_items = l:current_tag_items[:]
"     if l:current_tag_index <= len(l:current_tag_items)
"       call remove(l:new_tag_items, l:current_tag_index - 1, -1)
"     endif
"     let l:new_tag_items += l:new_tag_item
"
"     call settagstack(winnr(), #{curidx: l:new_tag_index, items: l:new_tag_items}, 'r')
"   endif
" endfunction

" function! ErlangTag(pattern, flags, info)
"   let l:funcname = expand("<cword>")
"   let l:line = getline(".")
"   let l:match_res = matchlist(line, "[a-zA-Z0-9'_]*:" . l:funcname)
"   if len(l:match_res) > 0
"     let [l:mod, l:fun] = split(l:match_res[0], ":")
"     return filter(taglist(a:pattern), 'get(v:val, "module", "") ==# l:mod')
"   else
"     return taglist(a:pattern)
"   endif
" endfunction

function! OnALELSPStarted() abort
    setlocal omnifunc=ale#completion#OmniFunc
    setlocal signcolumn=yes
    if exists('+tagfunc') | setlocal tagfunc=ALETagFunc | endif
    nmap <buffer> gd <plug>(ale_go_to_definition)
    nmap <buffer><silent> gs :ALESymbolSearch <cword><CR>
    nmap <buffer> gr <plug>(ale_find_references)
    nmap <buffer> gi <plug>(ale_go_to_implementation)
    " nmap <buffer> gt <plug>(ale_go_to_type_definition)
    nmap <buffer> <leader>rn :ALERename<CR>
    nmap <buffer> K <plug>(ale_hover)
endfunction

augroup ale
  autocmd!
  autocmd User ALELSPStarted call OnALELSPStarted()
augroup END

let g:ale_linters = {
\   'go': ['gobuild', 'gofmt'],
\   'proto': ['protolint'],
\   'ruby': ['standardrb', 'sorbet'],
\   'vim': ['vimls'],
\}

let g:ale_fixers = {
\   'go': ['gofmt', 'goimports'],
\   'proto': ['protolint'],
\   'ruby': ['standardrb', 'sorbet'],
\}

" fugitive
autocmd BufReadPost fugitive://* set bufhidden=delete

" goyo
nnoremap <leader>w :Goyo<CR>

" markdown
let g:markdown_fenced_languages = ['c', 'erb=eruby', 'diff', 'go', 'ruby', 'sh', 'sql']

" netrw
let g:netrw_bufsettings = 'noma nomod nu nobl nowrap ro'
augroup netrw
  autocmd!
  autocmd FileType netrw set colorcolumn=""
augroup END

" telescope
nnoremap <silent> <C-p> <cmd>Telescope find_files<cr>

" vim-test
let g:test#strategy = 'dispatch'

nmap <silent> <leader>tn :TestNearest<CR>
nmap <silent> <leader>tf :TestFile<CR>
nmap <silent> <leader>ts :TestSuite<CR>
nmap <silent> <leader>tl :TestLast<CR>
nmap <silent> <leader>tg :TestVisit<CR>
" }}}

" disable unsafe commands in exrc files
set secure
" vim: set foldmethod=marker:
