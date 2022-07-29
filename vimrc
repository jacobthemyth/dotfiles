let mapleader = "\<Space>"

syntax on

" Load matchit.vim, but only if the user hasn't installed a newer version.
if !exists('g:loaded_matchit') && findfile('plugin/matchit.vim', &rtp) ==# ''
  runtime! macros/matchit.vim
endif

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
  set grepprg=rg\ --vimgrep\ --smart-case\ $*
  set grepformat=%f:%l:%c:%m
endif

set number

" Open new split panes to right and bottom, which feels more natural
set splitbelow
set splitright

if filereadable(expand("~/.vimrc.bundles"))
  source ~/.vimrc.bundles
endif

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
if has("nvim")
  set fillchars=eob:\ ,stl:─,vert:│
else
  set fillchars=stl:─,vert:│
end

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

if filereadable(expand("~/.vim/colorscheme.vim"))
  let base16colorspace=256
  source ~/.vim/colorscheme.vim
endif

hi VertSplit guibg=NONE

set t_ZH=[3m
set t_ZR=[23m

" :h xterm-true-color
if &term =~# '^tmux'
  let &t_8f = "\<Esc>[38;2;%lu;%lu;%lum"
  let &t_8b = "\<Esc>[48;2;%lu;%lu;%lum"
endif
set termguicolors

highlight link ALEError Error
highlight htmlArg cterm=italic gui=italic
highlight Comment cterm=italic gui=italic
highlight Type    cterm=italic gui=italic
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

nnoremap <Leader>m :!open -a Marked\ 2.app "%"<CR><CR>

" EasyAlign
" Start interactive EasyAlign in visual mode (e.g. vipga)
xmap ga <Plug>(EasyAlign)

" Start interactive EasyAlign for a motion/text object (e.g. gaip)
nmap ga <Plug>(EasyAlign)

" Fugitive
nnoremap dp dp:redraw!<CR>
nnoremap do do:redraw!<CR>

nnoremap <Leader>s :%s/\<<C-r><C-w>\>//g<Left><Left>

nmap <leader>hi :call <SID>SynStack()<CR>
function! <SID>SynStack()
  if !exists("*synstack")
    return
  endif
  echo map(synstack(line('.'), col('.')), 'synIDattr(v:val, "name")')
endfunc
" }}}

" Plugins {{{
" airline
let g:airline_theme = 'base16_eighties'
let g:airline#extensions#tabline#enabled = 1
let g:airline#extensions#tabline#tab_min_count = 2
let g:airline#extensions#tabline#show_buffers = 0
let g:airline#extensions#tabline#show_tab_type = 0
let g:airline#extensions#tabline#show_close_button = 0
let g:airline_section_y = ""       " remove fileencoding[fileformat]
let g:airline_powerline_fonts = 1

" ale
let g:ale_statusline_format = ['⨉ %d', '⚠ %d', '']
nnoremap <Leader>af :ALEFix<CR>

" This is gross
let g:ale_javascript_eslint_executable='/bin/sh -c "cd $(dirname %) && ~/.nodenv/shims/eslint"'
let g:ale_use_global_executables = 1

let g:ale_linters = {
\   'css': ['stylelint'],
\   'go': ['gobuild', 'gofmt'],
\   'javascript': ['prettier', 'eslint'],
\   'ruby': ['rubocop'],
\   'c': ['cppcheck'],
\}
let g:ale_fixers = {
\   'go': ['gofmt', 'goimports'],
\   'javascript': ['eslint'],
\   'ruby': ['rubocop'],
\   'sql': ['pgformatter'],
\}

function! SetAleRubyBuffer()
  let ruby_linters = ["ruby"]
  let ruby_fixers = []

  if filereadable(".rubocop.yml") | :call add(ruby_linters, "rubocop") | :call add(ruby_fixers, "rubocop" ) | endif
  if filereadable("rails_best_practices.yml") | :call add(ruby_linters, "rails_best_pratices") | endif
  if filereadable(".reek") | :call add(ruby_linters, "reek") | endif

  let b:ale_linters = {
  \   'ruby': ruby_linters,
  \}
  let b:ale_fixers = {
  \   'ruby': ["rubocop"],
  \}
endfunction
augroup AleGroup
  autocmd!
  autocmd FileType,BufEnter ruby call SetAleRubyBuffer()
augroup END

" deoplete
let g:deoplete#enable_at_startup = 1
let s:default_sources = ['syntax', 'tag', 'buffer', 'file']
if (exists('g:deoplete_loaded') && g:deoplete_loaded)
  call deoplete#custom#option('sources', {
  \ '_': s:default_sources,
  \ 'go': ['go'] + s:default_sources,
  \})

  " https://github.com/Shougo/deoplete.nvim/issues/761
  call deoplete#custom#option('num_processes', 1)
endif

" fugitive
autocmd BufReadPost fugitive://* set bufhidden=delete

" fzf
nnoremap <silent> <C-p> :FZF<CR>

" goyo
nnoremap <leader>w :Goyo<CR>

" LanguageClient-neovim {{{
let g:LanguageClient_serverCommands = {
    \ 'rust': ['~/.cargo/bin/rustup', 'run', 'stable', 'rls'],
    \ 'ruby': ['~/.rbenv/shims/solargraph', 'stdio'],
    \ }

" note that if you are using Plug mapping you should not use `noremap` mappings.
nmap <leader>ls <Plug>(lcn-menu)
nmap <leader>lsh <Plug>(lcn-hover)
nmap <leader>lss <Plug>(lcn-symbols)
nmap <leader>lsr <Plug>(lcn-references)

" Rename - rn => rename
noremap <leader>rn :call LanguageClient#textDocument_rename()<CR>

" Rename - rc => rename camelCase
noremap <leader>rc :call LanguageClient#textDocument_rename(
            \ {'newName': Abolish.camelcase(expand('<cword>'))})<CR>

" Rename - rs => rename snake_case
noremap <leader>rs :call LanguageClient#textDocument_rename(
            \ {'newName': Abolish.snakecase(expand('<cword>'))})<CR>

" Rename - ru => rename UPPERCASE
noremap <leader>ru :call LanguageClient#textDocument_rename(
            \ {'newName': Abolish.uppercase(expand('<cword>'))})<CR>

nmap <silent> gd <Plug>(lcn-definition)
" }}}

" markdown
let g:markdown_folding = 1
au FileType markdown setlocal foldlevel=99
let g:markdown_fenced_languages = ['c', 'erb=eruby', 'diff', 'go', 'ruby', 'sh', 'sql']

" netrw
let g:netrw_bufsettings = 'noma nomod nu nobl nowrap ro'
augroup netrw
  autocmd!
  autocmd FileType netrw set colorcolumn=""
augroup END

" ruby
let g:ruby_indent_assignment_style = 'variable'

" taskpaper
augroup taskpaper
  autocmd!
  autocmd BufRead,BufNewFile *.taskpaper set filetype=taskpaper
  autocmd FileType taskpaper setlocal noexpandtab
augroup END

" vim-rust
let g:rustfmt_autosave = 1

" vim-test
let g:test#strategy = 'dispatch'

nmap <silent> t<C-n> :TestNearest<CR>
nmap <silent> t<C-f> :TestFile<CR>
nmap <silent> t<C-s> :TestSuite<CR>
nmap <silent> t<C-l> :TestLast<CR>
nmap <silent> t<C-g> :TestVisit<CR>

" vim-terraform
let g:terraform_align=1
let g:terraform_fmt_on_save=1
autocmd BufRead,BufNewFile *.hcl set filetype=terraform

" vim-wiki
let g:vimwiki_list = [{'path': '~/Dropbox/Notes', 'syntax': 'markdown', 'ext': '.wiki'}]
let g:vimwiki_ext2syntax = {'.wiki': 'markdown'}
let g:vimwiki_hl_headers = 1
let g:vimwiki_folding = 'expr'

" vim-wiki overrides - for file navigation, so this disables the header
" bingings but adds most of them back as the default.
let g:vimwiki_key_mappings =
  \ {
  \ 'headers': 0,
  \ }
autocmd FileType vimwiki nmap <Leader>- <Plug>VimwikiRemoveHeaderLevel
autocmd FileType vimwiki nmap <Leader>= <Plug>VimwikiAddHeaderLevel
autocmd FileType vimwiki nmap [[ <Plug>VimwikiGoToPrevHeader
autocmd FileType vimwiki nmap ]] <Plug>VimwikiGoToNextHeader
autocmd FileType vimwiki nmap [= <Plug>VimwikiGoToPrevSiblingHeader
autocmd FileType vimwiki nmap ]= <Plug>VimwikiGoToNextSiblingHeader
autocmd FileType vimwiki nmap [u <Plug>VimwikiGoToParentHeader
" }}}

let g:db_ui_use_nerd_fonts = 1
let g:db_ui_save_location = "~/Dropbox/sql"
let &t_ut=''
" adds a line of <
nmap <leader>al :normal 20i<<CR>
" makes Ascii art font
nmap <leader>aF :.!toilet -w 200 -f standard<CR>
nmap <leader>af :.!toilet -w 200 -f small<CR>
" makes Ascii border
nmap <leader>ab :.!toilet -w 200 -f term -F border<CR>

" presentation mode
nmap <F2> :call DisplayPresentationBoundaries()<CR>
nmap <F3> :call FindExecuteCommand()<CR>

let g:presentationBoundsDisplayed = 0
function! DisplayPresentationBoundaries()
  if g:presentationBoundsDisplayed
    match
    set colorcolumn=0
    let g:presentationBoundsDisplayed = 0
  else
    highlight lastoflines ctermbg=darkred guibg=darkred
    match lastoflines /\%23l/
    set colorcolumn=80
    let g:presentationBoundsDisplayed = 1
  endif
endfunction

function! FindExecuteCommand()
  let line = search('\S*!'.'!:.*')
  if line > 0
    let command = substitute(getline(line), "\S*!"."!:*", "", "")
    execute "silent !". command
    execute "normal gg0"
    redraw
  endif
endfunction

set conceallevel=3

function! MarkdownConcealLinks()
  syn region markdownLink matchgroup=markdownLinkDelimiter start="(" end=")" contains=markdownUrl keepend contained conceal cchar=→
endfunction

let g:sql_type_default = 'pgsql'

" disable unsafe commands in exrc files
set secure
" vim: set foldmethod=marker:
