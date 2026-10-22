-- Diff code blocks for print.
--
--   {.<lang> .diff}          a unified diff of <lang> source. Typst highlights
--                            one grammar per block, so emit it fenced as <lang>
--                            and scope the diff-line show rule (print.typ) that
--                            colors each line by its diff marker.
--   {.<lang> .diff-added}    the full contents of a file added or deleted whole.
--   {.<lang> .diff-deleted}  Emit it as ordinary <lang> source under a green or
--                            red header (diff-file in print.typ). <lang> may be
--                            omitted.
--
-- Plain ```diff and ```<lang> blocks are untouched.

local kinds = { diff = "diff", ["diff-added"] = "added", ["diff-deleted"] = "deleted" }

local function classify(block)
  local kind, language
  for _, class in ipairs(block.classes) do
    if kinds[class] then
      kind = kinds[class]
    elseif language == nil then
      language = class
    end
  end
  if kind == "diff" and language == nil then
    return nil -- a plain ```diff block keeps Typst's own diff highlighting
  end
  return kind, language or ""
end

local function fence_for(text)
  local fence = "```"
  while text:find(fence, 1, true) do
    fence = fence .. "`"
  end
  return fence
end

function CodeBlock(block)
  local kind, language = classify(block)
  if kind == nil then
    return nil
  end

  local fence = fence_for(block.text)
  local raw = fence .. language .. "\n" .. block.text .. "\n" .. fence
  local typst
  if kind == "diff" then
    typst = "#[\n#show raw.line: diff-line\n" .. raw .. "\n]\n"
  else
    typst = '#diff-file("' .. kind .. '")[\n' .. raw .. "\n]\n"
  end
  return pandoc.RawBlock("typst", typst)
end
