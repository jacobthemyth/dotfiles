require('control_escape')
local hyper = require('hyper')

-- HYPER+A: Act like ⌃a and move to beginning of line.
hyper:bind({}, 'a', nil, function()
  hs.eventtap.keyStroke({'⌃'}, 'a')
end)