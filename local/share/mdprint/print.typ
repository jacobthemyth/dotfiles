#set table(
  inset: (x: 4pt, y: 3pt),
  stroke: (x, y) => if y == 0 { 0.7pt } else { 0.35pt + luma(78%) },
)
#show table.header: set text(weight: "semibold")
#show figure.where(kind: table): set text(size: 8.5pt)

#let fit-to-width(body) = layout(available => {
  let natural = measure(body)
  if natural.width > available.width {
    scale(available.width / natural.width * 100%, reflow: true, body)
  } else {
    body
  }
})
#show image: image-content => fit-to-width(image-content)

#show terms: set block(spacing: 0.2em)
#show terms.item: item => block(
  breakable: true,
  inset: (left: 0.65em, top: 0.08em, bottom: 0.08em),
  [#strong(item.term): #item.description],
)
#show divider: set line(stroke: 0.35pt + luma(72%))
