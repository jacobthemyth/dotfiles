local identifiers = {}
local warned = {}

local function remember_identifier(element)
  if element.identifier ~= nil and element.identifier ~= "" then
    identifiers[element.identifier] = true
  end
end

local identifier_filter = {
  Code = remember_identifier,
  CodeBlock = remember_identifier,
  Div = remember_identifier,
  Figure = remember_identifier,
  Header = remember_identifier,
  Image = remember_identifier,
  Link = remember_identifier,
  Span = remember_identifier,
  Table = remember_identifier,
}

local function replace_unresolved_link(link)
  if link.target:sub(1, 1) ~= "#" then
    return nil
  end

  local target = link.target:sub(2)
  if target == "" or identifiers[target] then
    return nil
  end

  if not warned[target] then
    io.stderr:write(
      "mdprint: warning: unresolved internal link #",
      target,
      "; rendering its text without a hyperlink\n"
    )
    warned[target] = true
  end

  return link.content
end

function Pandoc(document)
  document:walk(identifier_filter)
  return document:walk({Link = replace_unresolved_link})
end
