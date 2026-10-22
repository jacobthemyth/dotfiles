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

// Colors one line of a {.<lang> .diff} block by its unified-diff marker while
// keeping the language highlighting Typst already applied (see diff-blocks.lua).
// Every line is wrapped the same way so the block keeps uniform line metrics.
#let diff-line(line) = {
  let t = line.text
  let paint(fill, body) = block(
    width: 100%, fill: fill, inset: (x: 3pt, y: 1.2pt), above: 0pt, below: 0pt,
    if t.len() == 0 [~] else { body },
  )
  if t.starts-with("diff --git") or t.starts-with("index ") or t.starts-with("--- ") or t.starts-with("+++ ") {
    paint(luma(92%), text(fill: luma(35%), weight: "semibold", t))
  } else if t.starts-with("@@") {
    paint(rgb("#ddf4ff"), text(fill: rgb("#0550ae"), t))
  } else if t.starts-with("+") {
    paint(rgb("#dafbe1"), line.body)
  } else if t.starts-with("-") {
    paint(rgb("#ffebe9"), line.body)
  } else {
    paint(none, line.body)
  }
}

// Wraps a file added or deleted whole: ordinary highlighted source under a
// green or red header, instead of a block of all-plus or all-minus lines.
#let diff-file(kind, body) = {
  let (fill, ink, label) = if kind == "added" {
    (rgb("#dafbe1"), rgb("#1a7f37"), "Added file")
  } else {
    (rgb("#ffebe9"), rgb("#cf222e"), "Deleted file")
  }
  // The header sticks to the first lines of the file; the file itself breaks
  // across pages like any other code block.
  block(
    width: 100%, fill: fill, inset: (x: 6pt, y: 3pt), below: 0pt, radius: (top: 2pt), sticky: true,
    text(size: 0.85em, weight: "semibold", fill: ink, label),
  )
  block(width: 100%, stroke: (left: 2pt + fill), inset: (left: 4pt), above: 0pt, breakable: true, body)
}
