on run argv
 set targetBundle to item 1 of argv
 set addedText to item 2 of argv
 tell application "System Events"
  set matchingProcesses to application processes whose bundle identifier is targetBundle
  if (count of matchingProcesses) is 0 then error "Open the requested app and its document first." number 17001
  set targetProcess to item 1 of matchingProcesses
  set frontmost of targetProcess to true
  tell targetProcess
   set field to value of attribute "AXFocusedUIElement"
   set fieldRole to value of attribute "AXRole" of field
   if fieldRole is not "AXTextArea" then error "Focus an editable document text area first." number 17002
   if exists attribute "AXSubrole" of field then
    if value of attribute "AXSubrole" of field is "AXSecureTextField" then error "Secure fields are not supported." number 17003
   end if
   if not settable of attribute "AXValue" of field then error "This document does not allow accessible text entry." number 17004
   set originalValue to value of attribute "AXValue" of field
   set oldText to originalValue
   if oldText is missing value then
    if (exists attribute "AXNumberOfCharacters" of field) then
     if (value of attribute "AXNumberOfCharacters" of field) is 0 then set oldText to ""
    end if
   end if
   if class of oldText is not text then error "The selected field is not a plain text document." number 17005
   if length of oldText > 100000 then error "This document is too large for safe text entry." number 17006
   if frontmost is not true then error "The focused app changed." number 17007
   if (value of attribute "AXValue" of field) is not originalValue then error "The document changed. No text was entered." number 17010
   try
    set value of attribute "AXValue" of field to (oldText & addedText)
   on error
    error "The document rejected text entry. Check it before retrying." number 17009
   end try
   try
    if value of attribute "AXValue" of field is not (oldText & addedText) then error "Readback differs."
   on error
    error "Text entry could not be verified. Do not retry automatically." number 17008
   end try
  end tell
 end tell
 return "text_appended"
end run
