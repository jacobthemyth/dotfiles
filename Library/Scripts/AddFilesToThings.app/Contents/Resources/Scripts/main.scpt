JsOsaDAS1.001.00bplist00�Vscript_�var app = Application.currentApplication()
app.includeStandardAdditions = true
var Things = Application("Things3")
var DEVONThink = Application("DEVONThink Pro Office")
var Finder = Application("Finder")

function confirm(text) {
  try {
    app.displayDialog(text)
    return true
  } catch (e) {
    return false
  }
}

function openDocuments(droppedItems) {
  droppedItems.forEach(makeToDoWithAttachment)
}
  
function makeToDoWithAttachment(item) {
  var alias = Application("System Events").aliases.byName(item.toString())
  var newTodo = Things.ToDo({name: alias.name()})
  Things.toDos.push(newTodo)  
  var newDocument = DEVONThink.import(alias.posixPath(), {to: DEVONThink.inbox})
  debugger
  newTodo.notes = `x-devonthink-item://${newDocument.uuid()}`
  newDocument.comment = `things:///show?id=${newTodo.id()}`
  
  if( confirm("Delete original?") ) {
	Finder.move(item, {
      to: Finder.trash()
    })
  }
}

function run() {
  var file = app.chooseFile()
  openDocuments([file])
}                              �jscr  ��ޭ