let syntastic_mode_map = { 'passive_filetypes': ['html'] }
let g:syntastic_javascript_checkers = ['eslint']
let g:syntastic_always_populate_loc_list = 1
let g:syntastic_json_checkers = ['jsonlint']

let g:syntastic_error_symbol = emoji#for('x')
let g:syntastic_style_error_symbol = emoji#for('interrobang')
let g:syntastic_warning_symbol = emoji#for('warning')
let g:syntastic_style_warning_symbol = emoji#for('poop')

highlight clear SignColumn
