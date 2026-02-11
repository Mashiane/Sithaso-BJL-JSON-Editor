Welcome

This project has been born out of the need to have [SithasoDaisy5 Low Code Generator](https://www.b4x.com/android/forum/threads/web-sithasodaisy5-low-code-a-source-code-generator-for-your-beautiful-banano-webapps.168619/#content) generate full bjl layouts from the UI created with the Low Code Tool.

With Sithaso BJL-JSON Editor, one is able to import and export both bjl layouts and bjl json based layouts. One is also able to view, edit the JSON file itself via the provided UI.

SithasoBJLDesigner is a powerful web-based WYSIWYG editor designed to handle B4X JSON Layout (.bjl) files directly in the browser. We break down the logic behind the drag-and-drop interface, binary file parsing, and state management. 

Key Features Covered: 
🔹 WYSIWYG Interface: See how the designer handles visual manipulation, including dragging, resizing, and snapping components to a 10px grid for precision alignment. 
🔹 Binary File Support: We look at the SithasoLayoutEngine and BJLConverter, which allow the browser to parse compressed binary .bjl files, convert them to JSON for editing, and re-export them for use in B4X applications. 
🔹 State Management & History: A look at the robust Undo/Redo stack that captures layout states before destructive actions (like delete or paste), ensuring a smooth user experience. 
🔹 Productivity Tools: • Clipboard Logic: How the designer manages Copy, Cut, Paste, and Duplicate operations, including smart offset logic to prevent overlapping components.
 • Auto-Save: The built-in recovery system that saves drafts to localStorage every 1.5 seconds to prevent data loss. 
 • Z-Order Control: Logic for "Bring to Front" and "Send to Back" by manipulating the order of the internal component list. 
 🔹 Advanced View Controls: • Outline Tree: A synchronized hierarchical view of your components using the SithasoBJLTree component. 
 • JSON Editor: Toggling between the visual canvas and raw JSON code for granular control. 
 • Theming & Zoom: Support for Light/Dark modes and canvas scaling/zooming.

 Check it out you YouTube
 
https://youtu.be/rcZyxrIkUws
