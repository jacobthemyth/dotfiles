syntax keyword sdKeywords
      \ participant
      \ as
      \ activate
      \ deactivate
      \ note
      \ group
      \ opt
      \ alt
      \ else
      \ neg
      \ end

syntax match sdInteraction "^.*:" contains=sdArrow

syntax match sdArrow "->" contained containedin=sdInteraction
syntax match sdArrow "->>" contained containedin=sdInteraction
syntax match sdArrow "-->" contained containedin=sdInteraction
syntax match sdArrow "-->>" contained containedin=sdInteraction
syntax match sdArrow "<->" contained containedin=sdInteraction
syntax match sdArrow "<-->" contained containedin=sdInteraction
syntax match sdArrow "<<->>" contained containedin=sdInteraction
syntax match sdArrow "<<-->>" contained containedin=sdInteraction

" come after sdInteraction since it's more specific
syntax match sdComment "#//#.*$"

highlight default link sdComment Comment

highlight default link sdArrow Function
highlight default link sdKeywords Keyword
