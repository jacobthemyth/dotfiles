" Run specs using vim-dispatch
let g:rspec_command = "Dispatch rspec {spec}"

" RSpec.vim mappings
map <Leader>t :call RunCurrentSpecFile()<CR>
map <Leader>s :call RunNearestSpec()<CR>
map <Leader>r :call RunLastSpec()<CR>
map <Leader>a :call RunAllSpecs()<CR>
