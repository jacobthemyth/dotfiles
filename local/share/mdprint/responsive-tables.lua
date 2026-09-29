local max_columns = 6
local max_score = 72
local max_unbroken = 36
local wrap_interval = 32

local function metadata_number(value, fallback)
  if value == nil then
    return fallback
  end

  return tonumber(pandoc.utils.stringify(value)) or fallback
end

function Meta(meta)
  max_columns = metadata_number(meta["responsive-table-max-columns"], max_columns)
  max_score = metadata_number(meta["responsive-table-max-score"], max_score)
end

local function has_class(element, class_name)
  for _, class in ipairs(element.attr.classes) do
    if class == class_name then
      return true
    end
  end
  return false
end

local function cell_text(cell)
  local value = pandoc.utils.stringify(cell)
  if value == "" then
    return "—"
  end
  return value
end

local function add_break_opportunities(value)
  local length = utf8.len(value)
  if length == nil or length <= max_unbroken then
    return value
  end

  local output = {}
  local position = 0
  for _, codepoint in utf8.codes(value) do
    if position > 0 and position % wrap_interval == 0 then
      table.insert(output, utf8.char(0x200B))
    end
    table.insert(output, utf8.char(codepoint))
    position = position + 1
  end
  return table.concat(output)
end

local function wrap_long_tokens(blocks)
  local container = pandoc.Div(blocks)
  return container:walk({
    Str = function(element)
      element.text = add_break_opportunities(element.text)
      return element
    end,
    Code = function(element)
      element.text = add_break_opportunities(element.text)
      return element
    end,
  }).content
end

local function column_count(simple)
  if simple.headers ~= nil and #simple.headers > 0 then
    return #simple.headers
  end
  if #simple.rows > 0 then
    return #simple.rows[1]
  end
  return 0
end

local function header_text(simple, column)
  local header = simple.headers and simple.headers[column]
  local value = header and pandoc.utils.stringify(header) or ""
  if value == "" then
    return "Column " .. column
  end
  return value
end

local function width_score(simple)
  local score = 0

  for column = 1, column_count(simple) do
    local longest_cell = #header_text(simple, column)
    local longest_token = 0

    for _, row in ipairs(simple.rows) do
      local value = cell_text(row[column])
      longest_cell = math.max(longest_cell, #value)

      for token in value:gmatch("%S+") do
        longest_token = math.max(longest_token, #token)
      end
    end

    score = score + math.max(6, math.min(longest_cell, 22), longest_token)
  end

  return score + math.max(0, (column_count(simple) - 1) * 3)
end

local function labeled_record(simple, row)
  local blocks = pandoc.Blocks({})
  local title = add_break_opportunities(header_text(simple, 1) .. ": " .. cell_text(row[1]))
  blocks:insert(pandoc.Para({pandoc.Strong({pandoc.Str(title)})}))

  local definitions = {}
  for column = 2, column_count(simple) do
    local term = {pandoc.Str(add_break_opportunities(header_text(simple, column)))}
    local description = wrap_long_tokens(row[column])
    if pandoc.utils.stringify(description) == "" then
      description = {pandoc.Plain({pandoc.Str("—")})}
    end
    table.insert(definitions, {term, {description}})
  end

  if #definitions > 0 then
    blocks:insert(pandoc.DefinitionList(definitions))
  end

  return blocks
end

function Table(table_element)
  if has_class(table_element, "keep-table") then
    return nil
  end

  local simple = pandoc.utils.to_simple_table(table_element)
  local should_stack = has_class(table_element, "stack-table")
    or column_count(simple) > max_columns
    or width_score(simple) > max_score

  if not should_stack then
    return nil
  end

  local blocks = pandoc.Blocks({})
  if pandoc.utils.stringify(simple.caption) ~= "" then
    blocks:insert(pandoc.Para({pandoc.Emph(simple.caption)}))
  end

  for row_number, row in ipairs(simple.rows) do
    if row_number > 1 then
      blocks:insert(pandoc.HorizontalRule())
    end
    blocks:insert(pandoc.RawBlock("typst", "#block(breakable: true)["))
    blocks:extend(labeled_record(simple, row))
    blocks:insert(pandoc.RawBlock("typst", "]"))
  end

  return pandoc.Div(blocks, pandoc.Attr("", {"stacked-table"}))
end
