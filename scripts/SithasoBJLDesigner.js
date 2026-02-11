class SithasoBJLDesigner extends HTMLElement {
  constructor() {
    super();
    this._engine = null;
    this._selectedId = null;
    this._showGrid = true;
    this._theme = "light";
    this._scale = 1.25;
    this._elementColors = {}; // Persistent hex colors
    this._availableComponents = []; // Internal library
    this._snapGrid = 10;
    this._magicMenuId = null;
    this._clipboard = null;
    this._history = [];
    this._redoStack = [];
    this._initialized = false;
    this._currentFilename = "layout.bjl";
    this._autoSaveTimer = null;
  }

  /**
   * Set the layout engine instance.
   */
  set engine(val) {
    this._engine = val;
    // Don't render here - engine starts empty
    // Render will happen in connectedCallback or when importing
    this._restoreDraft();
  }

  get engine() {
    return this._engine;
  }

  connectedCallback() {
    this.render();
    this.setupEventListeners();
    this.initJsonEditor();
  }

  initJsonEditor() {
    const container = this.querySelector("#jsonEditorContainer");
    if (container && typeof JSONEditor !== 'undefined') {
        const options = {
            mode: 'code',
            mainMenuBar: true,
            navigationBar: true,
            statusBar: true,
            onBlur: () => {
                // Pre-sync if needed
            }
        };
        this._jsonEditor = new JSONEditor(container, options);
    }
  }

  toggleJsonView() {
    const designerView = this.querySelector(".workspace-view");
    const jsonView = this.querySelector(".json-editor-view");
    const sidebar = this.querySelector(".tree-sidebar");
    const btn = this.querySelector("#btnToggleJson");
    const isJsonActive = jsonView.classList.contains("active");

    if (isJsonActive) {
        // Switching back to designer
        try {
            const updatedData = this._jsonEditor.get();
            this._engine.layout.Data = updatedData;
            this.updateWorkspace();
            this._updateOutline();
        } catch (err) {
            console.error("Invalid JSON:", err);
            Swal.fire("Error", "Invalid JSON data. Please fix errors before toggling.", "error");
            return;
        }
        
        jsonView.classList.remove("active");
        designerView.style.display = "flex";
        sidebar.style.display = "flex";
        btn.querySelector("i").className = "ri-code-s-line text-lg";
        btn.classList.remove("btn-active");
    } else {
        // Switching to JSON view
        this._jsonEditor.set(this._engine.getLayout().Data);
        
        designerView.style.display = "none";
        sidebar.style.display = "none";
        jsonView.classList.add("active");
        btn.querySelector("i").className = "ri-layout-line text-lg";
        btn.classList.add("btn-active");
    }
  }

  _getNextId(baseName) {
    const existingIds = [];
    const collectIds = (kids) => {
      if (!kids) return;
      for (const key in kids) {
        if (kids[key].name) existingIds.push(kids[key].name);
        if (kids[key][":kids"]) collectIds(kids[key][":kids"]);
      }
    };
    collectIds(this._engine.getLayout().Data[":kids"]);

    let max = 0;
    const escapedBase = baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`^${escapedBase}(\\d+)$`);
    existingIds.forEach((id) => {
      if (id === baseName && max === 0) max = 0;
      const match = id.match(regex);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > max) max = num;
      }
    });

    return `${baseName}${max + 1}`;
  }

  setupEventListeners() {
    this.addEventListener("mousedown", (e) => {
      const handle = e.target.closest(".resizer");
    const trigger = e.target.closest(".btn-item-trigger");

    if (trigger || e.target.closest(".magic-menu")) return;

    this._closeMagicMenu();

    if (handle) {
        e.stopPropagation();
        this.startResizing(e, handle.dataset.dir);
        return;
      }

      const item = e.target.closest(".designer-item");
      if (item) {
        e.stopPropagation();
        this.startDragging(e, item.dataset.id);
      } else if (
        e.target.closest(".workspace-view") &&
        !e.target.closest(".action-menu")
      ) {
        this.selectElement(null);
      }
    });

    window.addEventListener("keydown", (e) => {
      if (!this._selectedId) return;

      const step = e.shiftKey ? 10 : 1;
      let handled = false;

      if (e.key === "Delete") {
        this.deleteSelected();
        handled = true;
      } else if ((e.ctrlKey || e.metaKey) && e.key === "z") {
        this.undo();
        handled = true;
      } else if ((e.ctrlKey || e.metaKey) && e.key === "y") {
        this.redo();
        handled = true;
      } else if ((e.ctrlKey || e.metaKey) && e.key === "c") {
        this.copy();
        handled = true;
      } else if ((e.ctrlKey || e.metaKey) && e.key === "v") {
        this.paste();
        handled = true;
      } else if ((e.ctrlKey || e.metaKey) && e.key === "x") {
        this.cut();
        handled = true;
      } else if ((e.ctrlKey || e.metaKey) && e.key === "d") {
        this.duplicate();
        handled = true;
      } else if (e.key === "ArrowLeft") {
        this.saveState();
        this.nudge(-step, 0);
        handled = true;
      } else if (e.key === "ArrowRight") {
        this.saveState();
        this.nudge(step, 0);
        handled = true;
      } else if (e.key === "ArrowUp") {
        this.saveState();
        this.nudge(0, -step);
        handled = true;
      } else if (e.key === "ArrowDown") {
        this.saveState();
        this.nudge(0, step);
        handled = true;
      }

      if (handled) e.preventDefault();
    });

    // Magic Menu Delegation
    this.addEventListener("click", (e) => {
      const trigger = e.target.closest(".btn-item-trigger");
      const menuBtn = e.target.closest(".magic-menu button[data-action]");

      if (trigger) {
        e.preventDefault();
        e.stopPropagation();
        const id = trigger.closest(".designer-item").dataset.id;
      this.selectElement(id);
      this._toggleMagicMenu(id, trigger);
      return;
      }

      if (menuBtn) {
        e.preventDefault();
        e.stopPropagation();
        const action = menuBtn.dataset.action;
        const id = this._magicMenuId;

        this._closeMagicMenu();
        if (id) {
          this.selectElement(id);
          switch (action) {
            case "duplicate": this.duplicate(); break;
            case "cut": this.cut(); break;
            case "copy": this.copy(); break;
            case "paste": this.paste(); break;
            case "bring-to-front": this.bringToFront(); break;
            case "send-to-back": this.sendToBack(); break;
            case "delete": this.deleteSelected(); break;
          }
        }
        return;
      }

      if (!e.target.closest(".magic-menu")) {
        this._closeMagicMenu();
      }
    });

    // Close menu on scroll or outside click
    window.addEventListener("mousedown", (e) => {
      if (!e.target.closest(".magic-menu") && !e.target.closest(".btn-item-trigger")) {
        this._closeMagicMenu();
      }
    });

    const workspaceView = this.querySelector(".workspace-view");
    if (workspaceView) {
      workspaceView.addEventListener("scroll", () => this._closeMagicMenu(), true);
    }
  }

  _toggleMagicMenu(id, trigger) {
    const menu = this.querySelector("#magicMenu");
    if (!menu) return;

    const alreadyActive = menu.classList.contains("active") && this._magicMenuId === id;
    this._closeMagicMenu();

    if (!alreadyActive) {
      this._magicMenuId = id;
      const rect = trigger.getBoundingClientRect();
      menu.style.left = `${rect.left - 200}px`; 
      menu.style.top = `${rect.top - 45}px`;   
      menu.classList.add("active");
    }
  }

  _closeMagicMenu() {
    const menu = this.querySelector("#magicMenu");
    if (menu) {
      menu.classList.remove("active");
    }
    this._magicMenuId = null;
  }

  selectElement(id) {
    if (this._selectedId === id) return;
    this._selectedId = id;
    this.updateWorkspace();
    this.dispatchEvent(new CustomEvent("selection-change", { detail: { id } }));

    if (id) {
      const el = this.querySelector(`.designer-item[data-id="${id}"]`);
      if (el) {
        el.scrollIntoView({
          behavior: "smooth",
          block: "center",
          inline: "center",
        });
      }
    }

    const tree = this.querySelector("#outlineTree");
    if (tree) tree.select(id);
  }

  saveState() {
    if (!this._engine) return;
    const state = JSON.stringify(this._engine.getLayout().Data);
    // Only push if different from last state
    if (
      this._history.length === 0 ||
      this._history[this._history.length - 1] !== state
    ) {
      this._history.push(state);
      this._redoStack = []; // Clear redo on new action
      if (this._history.length > 50) this._history.shift(); // Limit history
      this._updateHistoryControls();
      this._triggerAutoSave();
    }
  }

  undo() {
    if (this._history.length === 0) return;

    // Save current state to redo stack before going back
    const currentState = JSON.stringify(this._engine.getLayout().Data);
    this._redoStack.push(currentState);

    // Restore last saved state
    const prevState = this._history.pop();
    this._engine.getLayout().Data = JSON.parse(prevState);

    this.updateWorkspace();
    this._updateOutline();
    this._updateHistoryControls();
  }

  redo() {
    if (this._redoStack.length === 0) return;

    // Save current state to history before going forward
    const currentState = JSON.stringify(this._engine.getLayout().Data);
    this._history.push(currentState);

    // Restore next state
    const state = this._redoStack.pop();
    this._engine.getLayout().Data = JSON.parse(state);

    this.updateWorkspace();
    this._updateOutline();
    this._updateHistoryControls();
  }

  cut() {
    if (!this._selectedId) return;
    this.copy();
    this.deleteSelected();
    this._updateClipboardControls();
  }

  copy() {
    if (!this._selectedId || !this._engine) return;
    const view = this._engine._findView(
      this._engine.getLayout().Data,
      this._selectedId,
    );
    if (view) {
      this._clipboard = JSON.parse(JSON.stringify(view));
      this._updateClipboardControls();
    }
  }

  paste() {
    if (!this._clipboard || !this._engine) return;
    this.saveState();

    // Deep clone the clipboard
    const newItem = JSON.parse(JSON.stringify(this._clipboard));

    // Generate a new unique ID
    const shortType = newItem.shortType || (newItem.customProperties && newItem.customProperties.shortType);
    let baseName = shortType;
    if (!baseName) {
        // Fallback to name without suffix
        baseName = newItem.name.split(/[0-9]/)[0].replace(/_$/, "");
    }
    
    const newId = this._getNextId(baseName);
    newItem.name = newId;
    newItem.eventName = newId;
    if (newItem.customProperties) {
        newItem.customProperties.eventName = newId;
        newItem.customProperties.Left = newItem.variant0.left + 20;
        newItem.customProperties.Top = newItem.variant0.top + 20;
    }

    // Offset a bit so it's not exactly on top
    newItem.variant0.left += 20;
    newItem.variant0.top += 20;

    // Add to main kids for now (simpler than finding parent)
    const kids = this._engine.getLayout().Data[":kids"];
    kids[newId] = newItem;

    this.selectElement(newId);
    this.updateWorkspace();
    this._updateOutline();
    this._updateClipboardControls();
  }

  duplicate() {
    if (!this._selectedId) return;
    this.copy();
    this.paste();
  }

  bringToFront() {
    if (!this._selectedId || !this._engine) return;
    this.saveState();

    try {
      this._engine.bringToFront(this._selectedId);
      this.updateWorkspace();
      this._updateOutline();
    } catch (e) {
      console.error("Bring to Front failed:", e);
    }
  }

  sendToBack() {
    if (!this._selectedId || !this._engine) return;
    this.saveState();

    try {
      this._engine.sendToBack(this._selectedId);
      this.updateWorkspace();
      this._updateOutline();
    } catch (e) {
      console.error("Send to Back failed:", e);
    }
  }

  deleteSelected() {
    if (!this._engine) return;
    this.saveState();

    // Tree is disconnected - only delete selected workspace element
    if (!this._selectedId) return;

    this._recursiveDelete(
      this._engine.getLayout().Data[":kids"],
      this._selectedId,
    );
    this._selectedId = null;
    this.updateWorkspace();
    this._updateOutline();
    this.dispatchEvent(new CustomEvent("delete-element"));
  }

  _recursiveDelete(kids, id) {
    if (!kids) return false;
    const key = Object.keys(kids).find((k) => kids[k].name === id);
    if (key) {
      delete kids[key];
      return true;
    }
    for (const k in kids) {
      if (kids[k][":kids"]) {
        if (this._recursiveDelete(kids[k][":kids"], id)) return true;
      }
    }
    return false;
  }

  _updateTooltip(el, view) {
    if (!el || !view) return;
    const tip = `Name: ${view.name}\nTop: ${view.variant0.top}\nLeft: ${view.variant0.left}\nWidth: ${view.variant0.width}\nHeight: ${view.variant0.height}`;
    el.setAttribute("data-tip", tip);
  }

  _triggerAutoSave() {
    if (this._autoSaveTimer) clearTimeout(this._autoSaveTimer);

    const status = this.querySelector("#saveStatus");
    if (status) {
      status.style.opacity = "1";
      status.innerHTML = `<i class="ri-loader-4-line animate-spin text-primary"></i> <span>Saving...</span>`;
    }

    this._autoSaveTimer = setTimeout(() => {
      this._autoSave();
    }, 1500);
  }

  _autoSave() {
    if (!this._engine) return;
    const state = {
      filename: this._currentFilename,
      data: this._engine.getLayout().Data,
    };
    localStorage.setItem("bjl_draft", JSON.stringify(state));

    const status = this.querySelector("#saveStatus");
    if (status) {
      status.innerHTML = `<i class="ri-checkbox-circle-fill text-success"></i> <span>Saved</span>`;
      setTimeout(() => {
        status.style.opacity = "0.3";
      }, 2000);
    }
  }

  _restoreDraft() {
    const draft = localStorage.getItem("bjl_draft");
    if (!draft || !this._engine) return;

    try {
      const { filename, data } = JSON.parse(draft);
      this._currentFilename = filename;
      this._engine.getLayout().Data = data;

      const titleEl = this.querySelector("#toolbarTitle");
      if (titleEl) titleEl.innerText = this._currentFilename;

      this.updateWorkspace();
      this._updateOutline();
    } catch (e) {
      console.error("Failed to restore draft:", e);
    }
  }

  nudge(dx, dy) {
    if (!this._selectedId || !this._engine) return;
    const view = this._engine._findView(
      this._engine.getLayout().Data,
      this._selectedId,
    );
    if (view) {
      view.variant0.left += dx;
      view.variant0.top += dy;
      if (view.customProperties) {
        view.customProperties.Left = view.variant0.left;
        view.customProperties.Top = view.variant0.top;
      }
      // Update only the element's position directly for performance
      const el = this.querySelector(
        `.designer-item[data-id="${this._selectedId}"]`,
      );
      if (el) {
        // We MUST multiply logical units by current scale for physical styles
        el.style.left = `${view.variant0.left * this._scale}px`;
        el.style.top = `${view.variant0.top * this._scale}px`;
        this._updateTooltip(el, view);
      }
    }
  }

  _updateOutline() {
    const tree = this.querySelector("#outlineTree");
    if (!tree || !this._engine) return;

    const layout = this._engine.getLayout();
    if (!layout || !layout.Data[":kids"]) {
      tree.clear();
      return;
    }

    const existingIds = new Set(tree.getExistingIds());
    const layoutIds = new Set();

    // 1. Add missing nodes AND ensure correct ordering
    const populate = (kids, parentID = "") => {
      Object.values(kids).forEach((view) => {
        layoutIds.add(view.name);
        if (!existingIds.has(view.name)) {
          tree.addNode(
            parentID,
            view.name,
            view.name,
            this._getColor(view.name),
            "",
          );
        } else {
          // Node exists, but might need re-ordering
          // Moving the element to the end of its parent container in the DOM
          // correctly reflects the insertion order in :kids (Z-order)
          const nodeEl = tree.querySelector(`li[data-id="${view.name}"]`);
          if (nodeEl && nodeEl.parentElement) {
            nodeEl.parentElement.appendChild(nodeEl);
          }
        }
        if (view[":kids"]) populate(view[":kids"], view.name);
      });
    };
    populate(layout.Data[":kids"]);

    // 2. Remove orphaned nodes (nodes in tree but not in layout)
    existingIds.forEach((id) => {
      if (!layoutIds.has(id)) {
        tree.removeNode(id);
      }
    });

    if (this._selectedId) tree.select(this._selectedId);
  }

  startResizing(e, dir) {
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const view = this._engine._findView(
      this._engine.getLayout().Data,
      this._selectedId,
    );
    if (!view) return;

    const initialLeft = view.variant0.left;
    const initialTop = view.variant0.top;
    const initialWidth = view.variant0.width;
    const initialHeight = view.variant0.height;
    const itemEl = this.querySelector(
      `.designer-item[data-id="${this._selectedId}"]`,
    );

    const onMouseMove = (moveE) => {
      if (itemEl) itemEl.classList.add("resizing");
      const dx = (moveE.clientX - startX) / this._scale;
      const dy = (moveE.clientY - startY) / this._scale;
      this.resize(
        dir,
        view,
        itemEl,
        initialLeft,
        initialTop,
        initialWidth,
        initialHeight,
        dx,
        dy,
      );
    };

    const onMouseUp = () => {
      if (itemEl) itemEl.classList.remove("resizing");
      this.updateWorkspace();
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }

  startDragging(e, id) {
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const view = this._engine._findView(this._engine.getLayout().Data, id);
    if (!view) return;

    const initialLeft = view.variant0.left;
    const initialTop = view.variant0.top;
    const itemEl = this.querySelector(`.designer-item[data-id="${id}"]`);

    let moved = false;
    const threshold = 5;

    const onMouseMove = (moveE) => {
      const dx = (moveE.clientX - startX) / this._scale;
      const dy = (moveE.clientY - startY) / this._scale;

      if (Math.abs(dx) > threshold || Math.abs(dy) > threshold) {
        if (!moved) this.saveState();
        moved = true;
        if (itemEl) itemEl.classList.add("dragging");
        this.drag(view, itemEl, initialLeft, initialTop, dx, dy);
      }
    };

    const onMouseUp = () => {
      if (itemEl) itemEl.classList.remove("dragging");

      if (!moved) {
        // It was a click -> Toggle selection
        this.toggleSelection(id);
      } else {
        // It was a drag -> Ensure selected
        this.selectElement(id);
      }

      // Only update workspace, not full render
      this.updateWorkspace();
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }

  drag(view, el, initialLeft, initialTop, dx, dy) {
    if (!view) return;

    // Apply snapping to the resulting coordinates (store unscaled values)
    view.variant0.left =
      Math.round((initialLeft + dx) / this._snapGrid) * this._snapGrid;
    view.variant0.top =
      Math.round((initialTop + dy) / this._snapGrid) * this._snapGrid;

    if (view.customProperties) {
      view.customProperties.Left = view.variant0.left;
      view.customProperties.Top = view.variant0.top;
    }

    // Update visual position with scale applied
    if (el) {
      el.style.left = `${view.variant0.left * this._scale}px`;
      el.style.top = `${view.variant0.top * this._scale}px`;
      this._updateTooltip(el, view);
    }
  }

  toggleSelection(id) {
    if (this._selectedId === id) {
      this.selectElement(null);
    } else {
      this.selectElement(id);
    }
  }

  resize(
    dir,
    view,
    el,
    initialLeft,
    initialTop,
    initialWidth,
    initialHeight,
    dx,
    dy,
  ) {
    if (!view) return;

    const v0 = view.variant0;

    if (dir.includes("e")) {
      v0.width = Math.max(
        this._snapGrid,
        Math.round((initialWidth + dx) / this._snapGrid) * this._snapGrid,
      );
    }
    if (dir.includes("s")) {
      v0.height = Math.max(
        this._snapGrid,
        Math.round((initialHeight + dy) / this._snapGrid) * this._snapGrid,
      );
    }

    if (dir.includes("w")) {
      const rawLeft = initialLeft + dx;
      v0.left = Math.round(rawLeft / this._snapGrid) * this._snapGrid;
      v0.width = Math.max(
        this._snapGrid,
        Math.round((initialWidth - (v0.left - initialLeft)) / this._snapGrid) *
          this._snapGrid,
      );
    }
    if (dir.includes("n")) {
      const rawTop = initialTop + dy;
      v0.top = Math.round(rawTop / this._snapGrid) * this._snapGrid;
      v0.height = Math.max(
        this._snapGrid,
        Math.round((initialHeight - (v0.top - initialTop)) / this._snapGrid) *
          this._snapGrid,
      );
    }

    if (view.customProperties) {
      view.customProperties.Left = v0.left;
      view.customProperties.Top = v0.top;
      view.customProperties.Width = v0.width;
      view.customProperties.Height = v0.height;
    }

    // Update visual dimensions with scale applied
    if (el) {
      el.style.left = `${v0.left * this._scale}px`;
      el.style.top = `${v0.top * this._scale}px`;
      el.style.width = `${v0.width * this._scale}px`;
      el.style.height = `${v0.height * this._scale}px`;
      this._updateTooltip(el, view);
    }
  }

  toggleGrid() {
    this._showGrid = !this._showGrid;
    const workspace = this.querySelector("#workspace");
    if (workspace) {
      if (this._showGrid) {
        workspace.classList.add("grid-dots");
      } else {
        workspace.classList.remove("grid-dots");
      }
    }
  }

  toggleTheme() {
    this._theme = this._theme === "light" ? "dark" : "light";
    const container = this.querySelector(".designer-container");
    const workspace = this.querySelector("#workspace");
    const themeBtn = this.querySelector("#btnTheme");

    if (container) {
      if (this._theme === "dark") {
        container.classList.add("dark");
      } else {
        container.classList.remove("dark");
      }
    }

    if (workspace) {
      if (this._theme === "light") {
        workspace.classList.remove("bg-[#2a2a2a]");
        workspace.classList.add("bg-white");
      } else {
        workspace.classList.remove("bg-white");
        workspace.classList.add("bg-[#2a2a2a]");
      }
    }

    // Update theme button icon
    if (themeBtn) {
      themeBtn.innerHTML =
        this._theme === "light"
          ? `<i class="ri-moon-line text-lg"></i>`
          : `<i class="ri-sun-line text-lg"></i>`;
    }

    this.dispatchEvent(
      new CustomEvent("theme-change", { detail: { theme: this._theme } }),
    );
  }

  refresh() {
    // For import: update workspace only
    this.updateWorkspace();
    this._updateOutline();
  }

  async clear(force = false) {
    if (!this._engine) return;

    let confirmed = force;
    if (!force) {
      const result = await Swal.fire({
        title: "Clear Layout?",
        text: "This will remove all components from the workspace. You can undo this action with Ctrl+Z.",
        icon: "warning",
        showCancelButton: true,
        confirmButtonColor: "#3b82f6",
        cancelButtonColor: "#6b7280",
        confirmButtonText: "Yes, clear it!",
        background: this._theme === "dark" ? "#1e1e1e" : "#ffffff",
        color: this._theme === "dark" ? "#ffffff" : "#1a1a1a",
      });
      confirmed = result.isConfirmed;
    }

    if (confirmed) {
      this.saveState();
      const layout = this._engine.getLayout();
      layout.Data[":kids"] = {};
      layout.LayoutHeader.ControlsHeaders =
        layout.LayoutHeader.ControlsHeaders.filter((h) => h.Name === "Main");
      this._selectedId = null;
      this._history = [];
      this._redoStack = [];
      this.updateWorkspace();
      this._updateOutline();
      this._updateHistoryControls();
      this.dispatchEvent(new CustomEvent("clear-layout"));
    }
  }

  setZoom(scale) {
    const oldScale = this._scale;
    this._scale = Math.min(2.0, Math.max(0.2, scale));

    const view = this.querySelector(".workspace-view");
    const scaler = this.querySelector(".workspace-scaler");
    const label = this.querySelector(".zoom-label");
    const range = this.querySelector("#vRangeScale");

    if (!view || !scaler) return;

    // Calculate current center relative to content scale
    const centerX = view.scrollLeft + view.clientWidth / 2;
    const centerY = view.scrollTop + view.clientHeight / 2;

    // Temporarily disable smooth scroll for instantaneous centering
    view.style.scrollBehavior = "auto";

    // Update scaler dimensions directly (this affects scroll size)
    const newSize = 600 * this._scale;
    scaler.style.width = `${newSize}px`;
    scaler.style.height = `${newSize}px`;

    if (label) label.innerText = `${Math.round(this._scale * 100)}%`;
    if (range) range.value = this._scale;

    // Adjust scroll to keep same point centered (Zoom around center)
    const ratio = this._scale / oldScale;
    view.scrollLeft = centerX * ratio - view.clientWidth / 2;
    view.scrollTop = centerY * ratio - view.clientHeight / 2;

    // Restore smooth scroll
    requestAnimationFrame(() => {
      view.style.scrollBehavior = "smooth";
    });

    // Update elements to reflect new scale
    this.updateWorkspace();
    this._updateHistoryControls();
  }

  _updateHistoryControls() {
    const btnUndo = this.querySelector("#btnUndo");
    const btnRedo = this.querySelector("#btnRedo");
    if (btnUndo) btnUndo.disabled = this._history.length === 0;
    if (btnRedo) btnRedo.disabled = this._redoStack.length === 0;
  }

  _getColor(id) {
    if (!this._elementColors[id]) {
      // Generate darker colors (max 160 per channel for visibility against light backgrounds)
      const r = Math.floor(Math.random() * 160);
      const g = Math.floor(Math.random() * 160);
      const b = Math.floor(Math.random() * 160);
      this._elementColors[id] = `#${r.toString(16).padStart(2, "0")}${g
        .toString(16)
        .padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
    }
    return this._elementColors[id];
  }

  render() {
    if (!this.isConnected) return;

    // If already initialized, just update workspace
    if (this._initialized) {
      this.updateWorkspace();
      return;
    }

    // Initial full render
    const gridClass = this._showGrid ? "grid-dots" : "";
    const themeClass =
      this._theme === "light"
        ? "bg-[#f4f4f4] text-[#1a1a1a]"
        : "bg-[#1a1a1a] text-white";
    const workspaceBg = this._theme === "light" ? "bg-white" : "bg-[#2a2a2a]";

    this.innerHTML = `
            <style>
                bjl-designer {
                    display: block;
                    width: 100%;
                    height: 100%;
                }
                .designer-container {
                    position: relative;
                    width: 100%;
                    height: 100%;
                    display: flex;
                    flex-direction: column;
                    border-radius: 1.5rem;
                    overflow: hidden;
                    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                }
                .main-toolbar {
                    height: 56px;
                    min-height: 56px;
                    padding: 0 1rem;
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                    background: rgba(0,0,0,0.02);
                    border-bottom: 1px solid rgba(0,0,0,0.05);
                    flex-shrink: 0;
                }
                .dark .main-toolbar {
                    background: rgba(255,255,255,0.02);
                    border-bottom: 1px solid rgba(255,255,255,0.05);
                }
                .content-area {
                    height: calc(100% - 56px);
                    display: flex;
                    overflow: hidden;
                    flex-shrink: 0;
                }
                .tree-sidebar {
                    width: 340px;
                    border-right: 1px solid rgba(0,0,0,0.05);
                    background: rgba(0,0,0,0.01);
                    display: flex;
                    flex-direction: column;
                    padding: 1.5rem;
                }
                .dark .tree-sidebar {
                    border-right: 1px solid rgba(255,255,255,0.05);
                    background: rgba(255,255,255,0.01);
                }
                .workspace-view {
                    flex: 1;
                    position: relative;
                    overflow: auto;
                    background: rgba(0,0,0,0.02);
                    scroll-behavior: smooth;
                    padding: 0.5rem;
                }
                .workspace-wrapper {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    box-sizing: border-box;
                    width: max-content;
                    height: max-content;
                    min-width: calc(100% - 4rem);
                    min-height: calc(100% - 4rem);
                }
                .workspace-scaler {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    transition: width 0.2s cubic-bezier(0.4, 0, 0.2, 1), height 0.2s cubic-bezier(0.4, 0, 0.2, 1);
                    flex-shrink: 0;
                }
                .action-menu {
                    position: sticky;
                    top: 0;
                    width: 64px;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 0.75rem;
                    padding: 1.5rem 0;
                    border: 1px solid rgba(0,0,0,0.05);
                    background: rgba(255,255,255,0.7);
                    backdrop-filter: blur(10px);
                    border-radius: 999px;
                    box-shadow: 0 10px 40px rgba(0,0,0,0.05);
                    z-index: 0;
                }
                .dark .action-menu {
                    border: 1px solid rgba(255,255,255,0.1);
                    background: rgba(30,30,30,0.7);
                    box-shadow: 0 10px 40px rgba(0,0,0,0.2);
                }
                .workspace-board {
                    position: relative;
                    display: inline-flex;
                    align-items: flex-start;
                    gap: 1.5rem;
                    padding: 1.5rem;
                }
                .nudge-grid {
                    display: grid;
                    grid-template-columns: repeat(3, 16px);
                    grid-template-rows: repeat(3, 16px);
                    gap: 1px;
                    width: 50px;
                    height: 50px;
                    background: rgba(0,0,0,0.05);
                    border-radius: 50%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    display: grid;
                    justify-content: center;
                    align-content: center;
                }
                .nudge-btn {
                    width: 16px !important;
                    height: 16px !important;
                    min-height: 16px !important;
                    padding: 0 !important;
                    font-size: 12px !important;
                    display: flex !important;
                    align-items: center !important;
                    justify-content: center !important;
                }
                .workspace {
                    position: relative;
                    width: 100%;
                    height: 100%;
                    box-shadow: 0 40px 100px rgba(0,0,0,0.1);
                    flex-shrink: 0;
                    border-radius: 8px;
                }
                .grid-dots {
                    background-image: radial-gradient(circle, rgba(0,0,0,0.1) 1px, transparent 1px);
                    background-size: 20px 20px;
                }
                .dark .grid-dots {
                    background-image: radial-gradient(circle, rgba(255,255,255,0.05) 1px, transparent 1px);
                }
                /* Support rich multi-line tooltips */
                .tooltip:before {
                    white-space: pre-line;
                    text-align: left;
                    max-width: none;
                }
                /* Dramatically smaller tooltips for designer items */
                .designer-item.tooltip:before {
                    font-size: 9px !important;
                    line-height: 1.2;
                    padding: 0.5rem;
                }
                .designer-item {
                    position: absolute;
                    cursor: move;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    border: 1px solid rgba(255,255,255,0.2);
                    box-sizing: border-box;
                    box-shadow: 0 4px 12px rgba(0,0,0,0.1);
                    border-radius: 4px;
                    user-select: none;
                    transition: left 0.3s cubic-bezier(0.4, 0, 0.2, 1), 
                                top 0.3s cubic-bezier(0.4, 0, 0.2, 1), 
                                width 0.3s cubic-bezier(0.4, 0, 0.2, 1), 
                                height 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                }
                .designer-item.dragging, .designer-item.resizing {
                    transition: none !important;
                }
                .designer-item.selected, .designer-item.dragging {
                    outline: 2.5px solid #3b82f6; 
                    outline-offset: 1px;
                }
                .designer-item.dragging:before, 
                .designer-item.dragging:after,
                .designer-item.resizing:before,
                .designer-item.resizing:after {
                    display: none !important;
                }
                .designer-item.dragging {
                    opacity: 0.5;
                    cursor: grabbing;
                    box-shadow: 0 20px 40px rgba(0,0,0,0.2);
                }
                .item-label {
                    color: white;
                    font-size: 10px;
                    pointer-events: none;
                    background: rgba(0,0,0,0.3);
                    padding: 4px 8px;
                    border-radius: 6px;
                    backdrop-filter: blur(4px);
                    transition: transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
                }
                .item-label.rotated {
                    transform: rotate(-90deg);
                    white-space: nowrap;
                }
                .resizer {
                    position: absolute;
                    width: 10px;
                    height: 10px;
                    background: #3b82f6;
                    border: 2px solid white;
                    border-radius: 50%;
                    z-index: 30;
                    display: none;
                }
                .selected .resizer { display: block; }

                .item-actions {
                    position: absolute;
                    top: 4px;
                    right: 4px;
                    opacity: 0;
                    display: flex;
                    align-items: center;
                    transition: opacity 0.2s;
                    z-index: 40;
                }
                .designer-item:hover .item-actions {
                    opacity: 1;
                }
                .btn-item-trigger {
                    width: 20px;
                    height: 20px;
                    min-height: 20px;
                    padding: 0;
                    border-radius: 50%;
                    background: rgba(255,255,255,0.2);
                    backdrop-filter: blur(4px);
                    color: white;
                    border: 1px solid rgba(255,255,255,0.3);
                }
                .btn-item-trigger:hover {
                    background: rgba(255,255,255,0.4);
                }
                .magic-menu {
                    position: fixed;
                    display: none;
                    background: color-mix(in oklch, var(--color-base-100), transparent 20%);
                    backdrop-filter: blur(16px);
                    border: 1px solid color-mix(in oklch, var(--color-base-content), transparent 85%);
                    border-radius: 9999px;
                    padding: 4px;
                    box-shadow: 0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1);
                    z-index: 2000;
                    animation: popIn 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
                }
                .magic-menu.active {
                    display: flex;
                    gap: 4px;
                }
                #jsonEditorContainer {
                    flex: 1;
                    height: 100%;
                }
                .json-editor-view {
                    display: none;
                    flex: 1;
                    overflow: hidden;
                    background: var(--color-base-100);
                }
                .json-editor-view.active {
                    display: flex;
                }
                /* JSONEditor Customization */
                .jsoneditor {
                    border: none !important;
                }
                .jsoneditor-menu {
                    background-color: var(--color-base-200) !important;
                    border-bottom: 1px solid color-mix(in oklch, var(--color-base-content), transparent 85%) !important;
                }
                .jsoneditor-statusbar {
                    background-color: var(--color-base-200) !important;
                    border-top: 1px solid color-mix(in oklch, var(--color-base-content), transparent 85%) !important;
                }
                @keyframes popIn {
                    from { opacity: 0; transform: scale(0.8) translateY(10px); }
                    to { opacity: 1; transform: scale(1) translateY(0); }
                }
            </style>
            
                <div class="main-toolbar">
                    <div class="flex items-center gap-2">
                        <!-- File Dropdown -->
                        <div class="dropdown">
                            <label tabindex="0" class="btn btn-sm btn-ghost gap-2 rounded-full px-4">
                                <i class="ri-file-list-3-line text-lg"></i>
                                <span>File</span>
                                <i class="ri-arrow-down-s-line"></i>
                            </label>
                            <ul tabindex="0" class="dropdown-content menu p-2 shadow bg-base-100 rounded-box w-52 z-[100]">
                                <li>
                                    <a id="btnImport">
                                        <i class="ri-upload-2-line"></i> Import BJL
                                    </a>
                                </li>
                                <li>
                                    <a id="btnImportJson">
                                        <i class="ri-file-code-line"></i> Import JSON
                                    </a>
                                </li>
                                <div class="divider my-0 opacity-10"></div>
                                <li>
                                    <a id="btnExport">
                                        <i class="ri-download-2-line"></i> Export BJL
                                    </a>
                                </li>
                                <li>
                                    <a id="btnExportJson">
                                        <i class="ri-code-s-slash-line"></i> Export JSON
                                    </a>
                                </li>
                                <div class="divider my-0 opacity-10"></div>
                                <li>
                                    <a id="btnExit" class="text-error hover:bg-error/10">
                                        <i class="ri-logout-box-r-line"></i> Exit
                                    </a>
                                </li>
                            </ul>
                        </div>
                        <input type="file" id="fileImport" accept=".bjl" style="display: none;">
                        <input type="file" id="fileImportJson" accept=".json" style="display: none;">

                    </div>

                    <div class="flex-1 flex justify-center items-center gap-3">
                        <span id="toolbarTitle" class="text-sm font-black opacity-60 px-4 py-1 bg-base-100/30 rounded-full border border-base-content/5 tracking-tight">
                            ${this._currentFilename}
                        </span>
                        <div id="saveStatus" class="flex items-center gap-1.5 text-[10px] font-bold opacity-30 transition-opacity duration-300">
                             <i class="ri-checkbox-circle-fill text-success"></i>
                             <span>Saved</span>
                        </div>
                    </div>

                    <div class="flex items-center gap-2">
                        <div class="tooltip tooltip-left tooltip-primary" data-tip="Toggle JSON Editor">
                            <button id="btnToggleJson" class="btn btn-circle btn-sm btn-ghost">
                                <i class="ri-code-s-line text-lg"></i>
                            </button>
                        </div>
                        <div class="flex items-center gap-2 px-4 bg-base-100/30 rounded-full py-1 border border-base-content/20">
                            <div class="tooltip tooltip-left tooltip-primary" data-tip="Zoom Out">
                                <button id="btnZoomOut" class="btn btn-circle btn-xs btn-ghost">
                                    <i class="ri-subtract-line text-sm"></i>
                                </button>
                            </div>
                            <input type="range" min="0.2" max="2.0" step="0.05" value="${this._scale}" class="range range-primary range-xs w-24" id="vRangeScale">
                            <div class="tooltip tooltip-left tooltip-primary" data-tip="Zoom In">
                                <button id="btnZoomIn" class="btn btn-circle btn-xs btn-ghost">
                                    <i class="ri-add-line text-sm"></i>
                                </button>
                            </div>
                            <span class="text-[11px] font-black opacity-60 w-10 text-center zoom-label">${Math.round(this._scale * 100)}%</span>
                            <div class="divider divider-horizontal mx-0 h-4 self-center"></div>
                            <div class="tooltip tooltip-left tooltip-primary" data-tip="Reset Zoom (100%)">
                                <button id="btnResetZoom" class="btn btn-circle btn-sm btn-ghost">
                                    <i class="ri-restart-line text-lg"></i>
                                </button>
                            </div>
                        </div>

                        <div class="tooltip tooltip-left tooltip-primary" data-tip="Switch Theme">
                            <button id="btnTheme" class="btn btn-circle btn-sm btn-ghost">
                                ${
                                  this._theme === "light"
                                    ? `<i class="ri-moon-line text-lg"></i>`
                                    : `<i class="ri-sun-line text-lg"></i>`
                                }
                            </button>
                        </div>
                        <div class="tooltip tooltip-left tooltip-primary" data-tip="Refresh UI">
                            <button id="btnRefresh" class="btn btn-circle btn-sm btn-ghost">
                                <i class="ri-refresh-line text-lg"></i>
                            </button>
                        </div>
                    </div>
                </div>

                <div class="content-area">
                    <div class="tree-sidebar">

                        <div class="flex-1 overflow-y-auto">
                            <bjl-tree id="outlineTree"></bjl-tree>
                        </div>
                    </div>

                    <div class="workspace-view">
                        <div class="workspace-wrapper">
                            <div class="workspace-board">
                                <div class="workspace-scaler" style="width: ${600 * this._scale}px; height: ${600 * this._scale}px;">
                                    <div class="workspace ${gridClass} ${workspaceBg}" id="workspace">
                                        ${this.renderElements()}
                                    </div>
                                </div>

                                <div class="action-menu">
                                    <div class="tooltip tooltip-left tooltip-primary" data-tip="Undo (Ctrl+Z)">
                                        <button id="btnUndo" class="btn btn-circle btn-ghost btn-sm" disabled>
                                            <i class="ri-arrow-go-back-line text-lg"></i>
                                        </button>
                                    </div>
                                    <div class="tooltip tooltip-left tooltip-primary" data-tip="Redo (Ctrl+Y)">
                                        <button id="btnRedo" class="btn btn-circle btn-ghost btn-sm" disabled>
                                            <i class="ri-arrow-go-forward-line text-lg"></i>
                                        </button>
                                    </div>
                                    <div class="divider my-0 opacity-10"></div>
                                    
                                    <div class="nudge-grid">
                                        <div class="col-start-2 row-start-1">
                                            <div class="tooltip tooltip-top tooltip-primary" data-tip="Nudge Up (Shift+Click: 10px)">
                                                <button id="btnNudgeUp" class="btn btn-circle btn-ghost nudge-btn" disabled>
                                                    <i class="ri-arrow-up-s-line"></i>
                                                </button>
                                            </div>
                                        </div>
                                        <div class="col-start-1 row-start-2">
                                            <div class="tooltip tooltip-left tooltip-primary" data-tip="Nudge Left">
                                                <button id="btnNudgeLeft" class="btn btn-circle btn-ghost nudge-btn" disabled>
                                                    <i class="ri-arrow-left-s-line"></i>
                                                </button>
                                            </div>
                                        </div>
                                        <div class="col-start-3 row-start-2">
                                            <div class="tooltip tooltip-right tooltip-primary" data-tip="Nudge Right">
                                                <button id="btnNudgeRight" class="btn btn-circle btn-ghost nudge-btn" disabled>
                                                    <i class="ri-arrow-right-s-line"></i>
                                                </button>
                                            </div>
                                        </div>
                                        <div class="col-start-2 row-start-3">
                                            <div class="tooltip tooltip-bottom tooltip-primary" data-tip="Nudge Down">
                                                <button id="btnNudgeDown" class="btn btn-circle btn-ghost nudge-btn" disabled>
                                                    <i class="ri-arrow-down-s-line"></i>
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div class="json-editor-view">
                        <div id="jsonEditorContainer"></div>
                    </div>
                </div>
            </div>
            <div id="magicMenu" class="magic-menu">
                <button class="btn btn-ghost btn-sm btn-circle tooltip tooltip-primary tooltip-top" data-tip="Cut" data-action="cut">
                    <i class="ri-scissors-line pointer-events-none"></i>
                </button>
                <button class="btn btn-ghost btn-sm btn-circle tooltip tooltip-primary tooltip-top" data-tip="Copy" data-action="copy">
                    <i class="ri-file-copy-line pointer-events-none"></i>
                </button>
                <button class="btn btn-ghost btn-sm btn-circle tooltip tooltip-primary tooltip-top" data-tip="Paste" data-action="paste" disabled>
                    <i class="ri-clipboard-line pointer-events-none"></i>
                </button>
                <button class="btn btn-ghost btn-sm btn-circle tooltip tooltip-primary tooltip-top" data-tip="Duplicate" data-action="duplicate">
                    <i class="ri-file-copy-2-line pointer-events-none"></i>
                </button>
                <button class="btn btn-ghost btn-sm btn-circle tooltip tooltip-primary tooltip-top" data-tip="Bring to Front" data-action="bring-to-front">
                    <i class="ri-bring-to-front pointer-events-none"></i>
                </button>
                <button class="btn btn-ghost btn-sm btn-circle tooltip tooltip-primary tooltip-top" data-tip="Send to Back" data-action="send-to-back">
                    <i class="ri-send-to-back pointer-events-none"></i>
                </button>
                <div class="divider divider-horizontal mx-0 opacity-10"></div>
                <button class="btn btn-ghost btn-sm btn-circle tooltip tooltip-error tooltip-top" data-tip="Delete" data-action="delete">
                    <i class="ri-delete-bin-line pointer-events-none text-error"></i>
                </button>
            </div>
        `;

    // Toolbar Handlers
    this.querySelector("#btnTheme").onclick = () => this.toggleTheme();
    this.querySelector("#btnRefresh").onclick = () => this.refreshApp();
    this.querySelector("#btnToggleJson").onclick = () => this.toggleJsonView();

    this.querySelector("#btnImport").onclick = (e) => {
      e.preventDefault();
      this.querySelector("#fileImport").click();
    };
    this.querySelector("#fileImport").onchange = async (e) => {
      const file = e.target.files[0];
      if (!file || !this._engine) return;

      try {
        this._currentFilename = file.name;
        const titleEl = this.querySelector("#toolbarTitle");
        if (titleEl) titleEl.innerText = this._currentFilename;

        await this._engine.loadFile(file);
        this.refresh();
        this.dispatchEvent(
          new CustomEvent("import-layout", { detail: { file } }),
        );
      } catch (error) {
        console.error("Import failed:", error);
      }
      e.target.value = ""; // Reset
    };
    this.querySelector("#btnExport").onclick = (e) => {
      e.preventDefault();
      if (this._engine) {
        this._engine.download(this._currentFilename);
      }
      this.dispatchEvent(new CustomEvent("export-layout"));
    };


    // JSON Handlers
    this.querySelector("#btnExportJson").onclick = (e) => {
        e.preventDefault();
        if (!this._engine) return;
        const layout = this._engine.getLayout();
        const blob = new Blob([JSON.stringify(layout, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = this._currentFilename.replace('.bjl', '.json');
        a.click();
        URL.revokeObjectURL(url);
        this.dispatchEvent(new CustomEvent("export-json"));
    };

    this.querySelector("#btnImportJson").onclick = (e) => {
        e.preventDefault();
        this.querySelector("#fileImportJson").click();
    };

    this.querySelector("#btnExit").onclick = async (e) => {
        e.preventDefault();
        const result = await Swal.fire({
            title: "Exit Designer?",
            text: "This will clear the current layout. Make sure you have saved your work.",
            icon: "question",
            showCancelButton: true,
            confirmButtonText: "Yes, Exit",
            confirmButtonColor: "#d33"
        });

        if (result.isConfirmed) {
            this.clear(true); // Forced clear
            this._currentFilename = "layout.bjl";
            const titleEl = this.querySelector("#toolbarTitle");
            if (titleEl) titleEl.innerText = this._currentFilename;
            localStorage.removeItem("bjl_draft");
        }
    };

    this.querySelector("#fileImportJson").onchange = async (e) => {
        const file = e.target.files[0];
        if (!file || !this._engine) return;

        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                const json = JSON.parse(event.target.result);
                if (json && json.Data) {
                    this._engine.layout = json;
                    this._currentFilename = file.name.replace('.json', '.bjl');
                    const titleEl = this.querySelector("#toolbarTitle");
                    if (titleEl) titleEl.innerText = this._currentFilename;
                    this.refresh();
                    this.dispatchEvent(new CustomEvent("import-json", { detail: { file } }));
                }
            } catch (err) {
                console.error("JSON Import failed:", err);
                Swal.fire("Import Error", "Invalid JSON layout file", "error");
            }
        };
        reader.readAsText(file);
        e.target.value = "";
    };

    this.querySelector("#vRangeScale").oninput = (e) => {
      this.setZoom(parseFloat(e.target.value));
    };
    this.querySelector("#btnZoomOut").onclick = () => {
      this.setZoom(this._scale - 0.05);
    };
    this.querySelector("#btnZoomIn").onclick = () => {
      this.setZoom(this._scale + 0.05);
    };
    this.querySelector("#btnResetZoom").onclick = () => {
      this.setZoom(1.0);
    };

    const view = this.querySelector(".workspace-view");
    if (view) {
      view.onwheel = (e) => {
        if (e.ctrlKey) {
          e.preventDefault();
          const delta = e.deltaY > 0 ? -0.05 : 0.05;
          this.setZoom(this._scale + delta);
        }
      };
    }

    // Action Menu Handlers
    this.querySelector("#btnUndo").onclick = () => this.undo();
    this.querySelector("#btnRedo").onclick = () => this.redo();

    // Nudge Handlers
    const getNudgeStep = (e) => (e.shiftKey ? 10 : 1);
    this.querySelector("#btnNudgeUp").onclick = (e) => {
      this.saveState();
      this.nudge(0, -getNudgeStep(e));
    };
    this.querySelector("#btnNudgeDown").onclick = (e) => {
      this.saveState();
      this.nudge(0, getNudgeStep(e));
    };
    this.querySelector("#btnNudgeLeft").onclick = (e) => {
      this.saveState();
      this.nudge(-getNudgeStep(e), 0);
    };
    this.querySelector("#btnNudgeRight").onclick = (e) => {
      this.saveState();
      this.nudge(getNudgeStep(e), 0);
    };

    // Outline Tree Handlers
    const outlineTree = this.querySelector("#outlineTree");
    if (outlineTree) {
      outlineTree.addEventListener("select", (e) =>
        this.selectElement(e.detail.id),
      );
      outlineTree.addEventListener("cut-node", (e) => {
        this.selectElement(e.detail.id);
        this.cut();
      });
      outlineTree.addEventListener("copy-node", (e) => {
        this.selectElement(e.detail.id);
        this.copy();
      });
      outlineTree.addEventListener("paste-node", (e) => {
        this.paste();
      });
      outlineTree.addEventListener("duplicate-node", (e) => {
        this.selectElement(e.detail.id);
        this.duplicate();
      });
      outlineTree.addEventListener("bring-to-front-node", (e) => {
        this.selectElement(e.detail.id);
        this.bringToFront();
      });
      outlineTree.addEventListener("send-to-back-node", (e) => {
        this.selectElement(e.detail.id);
        this.sendToBack();
      });
      outlineTree.addEventListener("delete-node", (e) => {
        this.selectElement(e.detail.id);
        this.deleteSelected();
      });
    }

    // Mark as initialized after first full render
    this._initialized = true;
  }

  updateWorkspace() {
    const workspace = this.querySelector("#workspace");
    if (!workspace || !this._engine) return;

    this._updateNudgeControls();
    this._updateClipboardControls();

    const layout = this._engine.getLayout();
    if (!layout || !layout.Data[":kids"]) return;

    const allViews = [];
    const traverse = (kids) => {
      Object.values(kids).forEach((view) => {
        allViews.push(view);
        if (view[":kids"]) traverse(view[":kids"]);
      });
    };
    traverse(layout.Data[":kids"]);

    const existingItems = workspace.querySelectorAll(".designer-item");

    // If count changed (add/delete/import), do a full re-render
    if (existingItems.length !== allViews.length) {
      workspace.innerHTML = this.renderElements();
      this.bindElementEvents();
      return;
    }

    // Smart Update: Update styles of existing elements to trigger transitions
    allViews.forEach((view, idx) => {
      const item = workspace.querySelector(
        `.designer-item[data-id="${view.name}"]`,
      );
      if (item) {
        // Physically reorder in DOM to match Z-order (last = front)
        console.log(`Z-Order Sync: Moving ${view.name} to DOM position ${idx}`);
        workspace.appendChild(item);

        const isSelected = this._selectedId === view.name;
        item.classList.toggle("selected", isSelected);

        // Toggle tooltip classes based on selection - tooltips are now click-only
        const tooltipClasses = [
          "tooltip",
          "tooltip-primary",
          "tooltip-right",
          "tooltip-open",
        ];
        if (isSelected) {
          item.classList.add(...tooltipClasses);
        } else {
          item.classList.remove(...tooltipClasses);
        }

        const scaledLeft = view.variant0.left * this._scale;
        const scaledTop = view.variant0.top * this._scale;
        const scaledWidth = view.variant0.width * this._scale;
        const scaledHeight = view.variant0.height * this._scale;

        item.style.left = `${scaledLeft}px`;
        item.style.top = `${scaledTop}px`;
        item.style.width = `${scaledWidth}px`;
        item.style.height = `${scaledHeight}px`;

        this._updateTooltip(item, view);

        // Update label rotation if needed
        const label = item.querySelector(".item-label");
        if (label) {
          label.classList.remove("rotated");
          if (label.offsetWidth > item.offsetWidth - 5) {
            label.classList.add("rotated");
          }
        }
      }
    });
  }

  _updateNudgeControls() {
    const isTargetSelected = this._selectedId !== null;
    ["btnNudgeUp", "btnNudgeDown", "btnNudgeLeft", "btnNudgeRight"].forEach(
      (id) => {
        const btn = this.querySelector(`#${id}`);
        if (btn) btn.disabled = !isTargetSelected;
      },
    );
  }

  _updateClipboardControls() {
    const hasClipboard = this._clipboard !== null;
    const magicPaste = this.querySelector(
      '.magic-menu button[data-action="paste"]',
    );
    if (magicPaste) magicPaste.disabled = !hasClipboard;

    const tree = this.querySelector("#outlineTree");
    if (tree && typeof tree.updatePasteState === "function") {
      tree.updatePasteState(hasClipboard);
    }
  }

  bindElementEvents() {
    // No local listeners needed - Handled by global delegation in setupEventListeners()

    // Handle label rotation for overflow
    this.querySelectorAll(".item-label").forEach((label) => {
      const parent = label.parentElement;
      if (!parent) return;

      // Remove rotated class first to get natural horizontal width
      label.classList.remove("rotated");

      // If label is wider than parent (width check)
      if (label.offsetWidth > parent.offsetWidth - 5) {
        label.classList.add("rotated");
      }
    });
  }

  renderElements() {
    if (
      !this._engine ||
      !this._engine.getLayout() ||
      !this._engine.getLayout().Data[":kids"]
    )
      return "";

    const allElements = [];
    const traverse = (kids) => {
      Object.values(kids).forEach((view) => {
        allElements.push(view);
        if (view[":kids"]) traverse(view[":kids"]);
      });
    };
    traverse(this._engine.getLayout().Data[":kids"]);

    return allElements
      .map((view) => {
        const isSelected = this._selectedId === view.name;
        const hexColor = this._getColor(view.name);
        // Scale element positions and sizes with the workspace
        const scaledLeft = view.variant0.left * this._scale;
        const scaledTop = view.variant0.top * this._scale;
        const scaledWidth = view.variant0.width * this._scale;
        const scaledHeight = view.variant0.height * this._scale;

        const tooltipTip = `Name: ${view.name}\nTop: ${view.variant0.top}\nLeft: ${view.variant0.left}\nWidth: ${view.variant0.width}\nHeight: ${view.variant0.height}`;

        const tooltipClasses = isSelected
          ? "tooltip tooltip-primary tooltip-right tooltip-open"
          : "";

        return `
                <div class="designer-item ${tooltipClasses} ${isSelected ? "selected" : ""}" 
                     data-id="${view.name}"
                     data-tip="${tooltipTip}"
                     style="left: ${scaledLeft}px; 
                            top: ${scaledTop}px; 
                            width: ${scaledWidth}px; 
                            height: ${scaledHeight}px;
                            background: ${hexColor};">
                    <span class="item-label">${view.name}</span>
                    <div class="item-actions">
                        <button class="btn btn-item-trigger">
                            <i class="ri-more-2-fill pointer-events-none"></i>
                        </button>
                    </div>
                    <div class="resizer nw" data-dir="nw" style="top: -5px; left: -5px; cursor: nwse-resize;"></div>
                    <div class="resizer n" data-dir="n" style="top: -5px; left: calc(50% - 5px); cursor: ns-resize;"></div>
                    <div class="resizer ne" data-dir="ne" style="top: -5px; right: -5px; cursor: nesw-resize;"></div>
                    <div class="resizer e" data-dir="e" style="top: calc(50% - 5px); right: -5px; cursor: ew-resize;"></div>
                    <div class="resizer se" data-dir="se" style="bottom: -5px; right: -5px; cursor: nwse-resize;"></div>
                    <div class="resizer s" data-dir="s" style="bottom: -5px; left: calc(50% - 5px); cursor: ns-resize;"></div>
                    <div class="resizer sw" data-dir="sw" style="bottom: -5px; left: -5px; cursor: nesw-resize;"></div>
                    <div class="resizer w" data-dir="w" style="top: calc(50% - 5px); left: -5px; cursor: ew-resize;"></div>
                </div>
            `;
      })
      .join("");
  }
}

customElements.define("bjl-designer", SithasoBJLDesigner);
