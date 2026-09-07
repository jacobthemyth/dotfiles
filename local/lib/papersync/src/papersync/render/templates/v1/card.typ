#let d = json(bytes(sys.inputs.data))
#let g = d.geometry
#let mm(v) = v * 1mm
#let rect_at(r, ..args) = place(top + left, dx: mm(r.x), dy: mm(r.y), rect(width: mm(r.w), height: mm(r.h), ..args))

#let chrome(page_no) = {
  for f in g.fiducials { rect_at(f, fill: black, stroke: none) }
  let qr = d.qrs.at(calc.min(page_no, d.qrs.len()) - 1)
  place(top + left, dx: mm(g.qr.x), dy: mm(g.qr.y), image(bytes(qr), width: mm(g.qr.w), height: mm(g.qr.h)))
  let total = d.qrs.len()
  let foot = if total > 1 { d.footer + " · " + str(page_no) + "/" + str(total) } else { d.footer }
  // Rotated 90 degrees clockwise down the right margin: the box's width runs
  // down the strip and its height extends left of dx, so anchor at the strip's
  // right edge.
  place(top + left, dx: mm(g.footer.x + g.footer.w), dy: mm(g.footer.y),
    rotate(90deg, origin: top + left, reflow: true,
      box(width: mm(g.footer.h), height: mm(g.footer.w),
        align(left + horizon, text(size: 6pt, fill: luma(110), font: "New Computer Modern Sans")[#foot]))))
  if page_no == 1 {
    rect_at(g.done_box, stroke: 0.4pt)
    place(top + left, dx: mm(g.title_bar.x), dy: mm(g.title_bar.y),
      block(width: mm(g.title_bar.w), fill: luma(225), inset: 4pt,
        text(font: "New Computer Modern Sans", weight: "bold", size: 10pt)[#d.title]))
    for b in g.meta_boxes {
      rect_at(b.rect, stroke: 0.4pt)
      place(top + left, dx: mm(b.rect.x), dy: mm(b.rect.y + b.rect.h + 0.5),
        text(size: 6pt, font: "New Computer Modern Sans")[#b.label])
    }
  } else {
    place(top + left, dx: mm(g.title_bar.x), dy: mm(g.title_bar.y),
      block(width: mm(g.title_bar.w), fill: luma(225), inset: 4pt,
        text(font: "New Computer Modern Sans", weight: "bold", size: 10pt)[#d.continuation_title]))
  }
  if d.lined {
    let n = calc.floor((g.height - g.top - g.bottom) / 7)
    for i in range(n) {
      place(top + left, dx: mm(g.margin), dy: mm(g.top + (i + 1) * 7),
        line(length: mm(g.width - 2 * g.margin), stroke: 0.2pt + luma(190)))
    }
  }
}

#set page(width: mm(g.width), height: mm(g.height),
  margin: (top: mm(g.top), bottom: mm(g.bottom), left: mm(g.margin), right: mm(g.margin)),
  background: context chrome(counter(page).get().first()))
#set text(font: "New Computer Modern", size: 10pt)
#set par(leading: 0.55em, spacing: 0.9em)

#if not d.lined [
  #for line in d.notes.split("\n") [#line \ ]
]
