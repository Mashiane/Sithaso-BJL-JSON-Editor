class SithasoBJLDesigner extends HTMLElement {
  constructor() {
    super();
    this._engine = null;
    // Multi-select support: Use Set for multiple selections
    this._selectedIds = new Set();
    this._lastSelectedId = null;
    this._selectionAnchor = null;
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
    this._jsonContent = { json: {} };
    this._jsonMode = "tree";

    // Default Settings
    this._defaultSettings = {
      showGrid: true,
      snapDensity: 10,
      showTooltips: true,
      showLabels: false,
      initialZoom: 125,
      selectionColor: "#3b82f6",
      autoSaveInterval: 30000, // 30s
      undoHistoryLimit: 50,
      nudgeStep: 1,
      nudgeShiftStep: 10,
      autoScroll: true
    };
    this._settings = { ...this._defaultSettings };
    this._loadSettings();
    
    // Sync class properties with settings
    this._showGrid = this._settings.showGrid;
    this._snapGrid = this._settings.snapDensity;
    this._scale = this._settings.initialZoom / 100;
  }

  /**
   * Backward compatibility: Get single selected ID (first if multiple)
   */
  get _selectedId() {
    return this._selectedIds.size === 1 ? Array.from(this._selectedIds)[0] : null;
  }

  /**
   * Multi-select: Check if an element is selected
   */
  isSelected(id) {
    return this._selectedIds.has(id);
  }

  /**
   * Multi-select: Get count of selected elements
   */
  get selectionCount() {
    return this._selectedIds.size;
  }

  /**
   * Set the layout engine instance.
   */
  set engine(val) {
    this._engine = val;
    this._syncEngineVariantBoundsFromLayout();
    // Don't render here - engine starts empty
    // Render will happen in connectedCallback or when importing
    this._restoreDraft();
  }

  get engine() {
    return this._engine;
  }

  _syncEngineVariantBoundsFromLayout() {
    if (
      this._engine &&
      typeof this._engine.syncVariantBoundsFromLayout === "function"
    ) {
      this._engine.syncVariantBoundsFromLayout();
    }
  }

  _getWorkspaceBaseSize() {
    const fallbackWidth =
      Number(this._engine && this._engine.variantWidth) > 0
        ? Number(this._engine.variantWidth)
        : 600;
    const fallbackHeight =
      Number(this._engine && this._engine.variantHeight) > 0
        ? Number(this._engine.variantHeight)
        : 600;

    const layout =
      this._engine && typeof this._engine.getLayout === "function"
        ? this._engine.getLayout()
        : null;
    const variant0 =
      layout && Array.isArray(layout.Variants) ? layout.Variants[0] : null;
    const width = Number(variant0 && variant0.Width);
    const height = Number(variant0 && variant0.Height);

    return {
      width: Number.isFinite(width) && width > 0 ? width : fallbackWidth,
      height: Number.isFinite(height) && height > 0 ? height : fallbackHeight,
    };
  }

  _applyWorkspaceScalerSize() {
    const scaler = this.querySelector(".workspace-scaler");
    if (!scaler) return;
    const base = this._getWorkspaceBaseSize();
    scaler.style.width = `${base.width * this._scale}px`;
    scaler.style.height = `${base.height * this._scale}px`;
  }

  _getOrderedKids(kids) {
    if (!kids || typeof kids !== "object") return [];
    return Object.keys(kids)
      .sort((a, b) => {
        const na = Number(a);
        const nb = Number(b);
        if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
        return String(a).localeCompare(String(b));
      })
      .map((k) => kids[k]);
  }

  _getAnchorValue(value) {
    const n = Number(value);
    if (n === 1 || n === 2) return n;
    return 0;
  }

  _resolveAnchoredRect(v0, parentRect) {
    const leftMargin = Number(v0 && v0.left) || 0;
    const topMargin = Number(v0 && v0.top) || 0;
    const rightMarginOrWidth = Number(v0 && v0.width) || 0;
    const bottomMarginOrHeight = Number(v0 && v0.height) || 0;
    const hanchor = this._getAnchorValue(v0 && v0.hanchor);
    const vanchor = this._getAnchorValue(v0 && v0.vanchor);

    let left = parentRect.left + leftMargin;
    let top = parentRect.top + topMargin;
    let width = rightMarginOrWidth;
    let height = bottomMarginOrHeight;

    if (hanchor === 1) {
      left =
        parentRect.left +
        parentRect.width -
        leftMargin -
        rightMarginOrWidth;
      width = rightMarginOrWidth;
    } else if (hanchor === 2) {
      width = Math.max(
        0,
        parentRect.width - leftMargin - rightMarginOrWidth,
      );
    }

    if (vanchor === 1) {
      top =
        parentRect.top +
        parentRect.height -
        topMargin -
        bottomMarginOrHeight;
      height = bottomMarginOrHeight;
    } else if (vanchor === 2) {
      height = Math.max(
        0,
        parentRect.height - topMargin - bottomMarginOrHeight,
      );
    }

    return {
      left,
      top,
      width: Math.max(0, width),
      height: Math.max(0, height),
      hanchor,
      vanchor,
    };
  }

  _snapValue(value) {
    const step = Math.max(1, Number(this._snapGrid) || 1);
    return Math.round((Number(value) || 0) / step) * step;
  }

  _applyResolvedRectToVariant(v0, parentRect, rect, options = {}) {
    if (!v0 || !parentRect || !rect) return;
    const shouldSnap = options.snap !== false;
    const writeValue = (value) =>
      shouldSnap ? this._snapValue(value) : Number(value) || 0;

    const parentLeft = Number(parentRect.left) || 0;
    const parentTop = Number(parentRect.top) || 0;
    const parentWidth = Math.max(0, Number(parentRect.width) || 0);
    const parentHeight = Math.max(0, Number(parentRect.height) || 0);

    const left = writeValue(rect.left);
    const top = writeValue(rect.top);
    const width = Math.max(0, writeValue(rect.width));
    const height = Math.max(0, writeValue(rect.height));

    const localLeft = left - parentLeft;
    const localTop = top - parentTop;
    const hanchor = this._getAnchorValue(v0.hanchor);
    const vanchor = this._getAnchorValue(v0.vanchor);

    if (hanchor === 1) {
      v0.left = writeValue(parentWidth - localLeft - width);
      v0.width = width;
    } else if (hanchor === 2) {
      v0.left = writeValue(localLeft);
      v0.width = writeValue(parentWidth - localLeft - width);
    } else {
      v0.left = writeValue(localLeft);
      v0.width = width;
    }

    if (vanchor === 1) {
      v0.top = writeValue(parentHeight - localTop - height);
      v0.height = height;
    } else if (vanchor === 2) {
      v0.top = writeValue(localTop);
      v0.height = writeValue(parentHeight - localTop - height);
    } else {
      v0.top = writeValue(localTop);
      v0.height = height;
    }
  }

  _getResolvedLayoutState() {
    const records = [];
    const map = new Map();

    if (!this._engine || typeof this._engine.getLayout !== "function") {
      const base = this._getWorkspaceBaseSize();
      return {
        records,
        map,
        rootRect: {
          left: 0,
          top: 0,
          width: base.width,
          height: base.height,
          right: base.width,
          bottom: base.height,
        },
      };
    }

    const layout = this._engine.getLayout();
    const kids = layout && layout.Data ? layout.Data[":kids"] : null;
    const base = this._getWorkspaceBaseSize();
    const rootRect = {
      left: 0,
      top: 0,
      width: base.width,
      height: base.height,
      right: base.width,
      bottom: base.height,
    };

    const walk = (childKids, parentRect, parentId) => {
      this._getOrderedKids(childKids).forEach((view) => {
        if (!view || !view.name || !view.variant0) return;
        const rect = this._resolveAnchoredRect(view.variant0, parentRect);
        const record = {
          id: view.name,
          view,
          orderIndex: records.length,
          parentId: parentId || "",
          parentRect: {
            left: parentRect.left,
            top: parentRect.top,
            width: parentRect.width,
            height: parentRect.height,
          },
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          right: rect.left + rect.width,
          bottom: rect.top + rect.height,
          area: rect.width * rect.height,
          hanchor: rect.hanchor,
          vanchor: rect.vanchor,
        };
        records.push(record);
        map.set(record.id, record);
        walk(view[":kids"], record, record.id);
      });
    };

    walk(kids, rootRect, "");
    return { records, map, rootRect };
  }

  connectedCallback() {
    this.id = this.id || `bjl-${Math.random().toString(36).substr(2, 9)}`;
    this._scale = this._settings.initialZoom / 100;
    this.style.setProperty("--selection-color", this._settings.selectionColor);
    this.render();
    this.setupEventListeners();
    this.initJsonEditor();
  }

  static _loadVanillaJsonEditorModule() {
    if (!SithasoBJLDesigner._vanillaJsonEditorModulePromise) {
      SithasoBJLDesigner._vanillaJsonEditorModulePromise = (async () => {
        if (
          window.VanillaJsonEditor &&
          typeof window.VanillaJsonEditor.createJSONEditor === "function"
        ) {
          return window.VanillaJsonEditor;
        }

        // Load our local bridge if the head-loaded module has not run yet.
        try {
          await import("./vanilla-jsoneditor-bridge.js");
        } catch (error) {
          console.error(
            "Failed to import local Vanilla JSONEditor bridge:",
            error,
          );
        }

        if (
          window.VanillaJsonEditor &&
          typeof window.VanillaJsonEditor.createJSONEditor === "function"
        ) {
          return window.VanillaJsonEditor;
        }

        throw new Error("VanillaJsonEditor bridge is not available");
      })();
    }
    return SithasoBJLDesigner._vanillaJsonEditorModulePromise;
  }

  _toEditorContentFromJson(json) {
    return { json: json || {} };
  }

  _toJsonFromEditorContent(content) {
    if (!content || typeof content !== "object") {
      throw new Error("JSON editor returned invalid content");
    }
    if (Object.prototype.hasOwnProperty.call(content, "json")) {
      return content.json || {};
    }
    if (typeof content.text === "string") {
      const text = content.text.trim();
      return text.length === 0 ? {} : JSON.parse(text);
    }
    throw new Error("Unsupported JSON editor content type");
  }

  async initJsonEditor() {
    const container = this.querySelector("#jsonEditorContainer");
    if (!container || this._jsonEditor) return;

    try {
      const lib = await SithasoBJLDesigner._loadVanillaJsonEditorModule();
      if (!lib || typeof lib.createJSONEditor !== "function") {
        throw new Error("createJSONEditor is not available");
      }

      const queryLanguages = [
        lib.javascriptQueryLanguage,
        lib.jmespathQueryLanguage,
        lib.jsonQueryLanguage,
        lib.jsonpathQueryLanguage,
        lib.lodashQueryLanguage,
      ].filter((q) => typeof q === "function" || (q && typeof q === "object"));

      const initialJson =
        this._engine && typeof this._engine.getLayout === "function"
          ? this._engine.getLayout()?.Data || {}
          : {};
      this._jsonContent = this._toEditorContentFromJson(initialJson);
      this._jsonMode = "tree";

      this._jsonEditor = lib.createJSONEditor({
        target: container,
        props: {
          mode: this._jsonMode,
          content: this._jsonContent,
          mainMenuBar: true,
          navigationBar: true,
          statusBar: true,
          askToFormat: true,
          readOnly: false,
          queryLanguages,
          onChangeMode: (mode) => {
            this._jsonMode = mode || "tree";
            if (
              this._jsonEditor &&
              typeof this._jsonEditor.updateProps === "function"
            ) {
              this._jsonEditor.updateProps({ mode: this._jsonMode });
            }
          },
          onChange: (updatedContent) => {
            this._jsonContent = updatedContent;
          },
          onError: (err) => {
            console.error("JSON editor error:", err);
          },
        },
      });
    } catch (error) {
      console.error("Failed to initialize Vanilla JSONEditor:", error);
    }
  }

  async toggleJsonView() {
    const designerView = this.querySelector(".workspace-view");
    const jsonView = this.querySelector(".json-editor-view");
    const sidebar = this.querySelector(".tree-sidebar");
    const btn = this.querySelector("#btnToggleJson");
    const isJsonActive = jsonView.classList.contains("active");

    if (!this._jsonEditor) {
      await this.initJsonEditor();
    }
    if (!this._jsonEditor) return;

    if (isJsonActive) {
        // Switching back to designer
        try {
            const content = this._jsonEditor.get();
            const updatedData = this._toJsonFromEditorContent(content);
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
        this._jsonContent = this._toEditorContentFromJson(
          this._engine.getLayout().Data,
        );
        this._jsonEditor.set(this._jsonContent);
        
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
      // Use left button only for drag/resize interactions.
      if (e.button !== 0) return;

      const handle = e.target.closest(".resizer");
      const trigger = e.target.closest(".btn-item-trigger");

      if (trigger || e.target.closest(".magic-menu")) return;

      this._closeMagicMenu();

      if (handle) {
        e.stopPropagation();
        // Allow resize for single and multi-selection
        if (this._selectedIds.size > 0) {
          this.startResizing(e, handle.dataset.dir);
        }
        return;
      }

      const item = e.target.closest(".designer-item");
      if (item) {
        e.stopPropagation();
        const id = item.dataset.id;
        
        // Handle multi-select with modifier keys
        if (e.ctrlKey || e.metaKey) {
          // Ctrl/Cmd + Click: Toggle selection
          this.selectElement(id, { toggle: true, clearExisting: false });
          this._selectionAnchor = id;
        } else if (e.shiftKey && this._selectionAnchor) {
          // Shift + Click: Range selection
          this.selectElement(id, { isRange: true, clearExisting: true });
        } else {
          // Normal click: Select single, clear others
          if (!this._selectedIds.has(id)) {
            this.selectElement(id, { clearExisting: true });
          }
          this._selectionAnchor = id;
        }
        
        // Always start drag (move all selected)
        this.startDragging(e, id);
      } else if (
        e.target.closest(".workspace-view") &&
        !e.target.closest(".action-menu") &&
        !e.target.closest("#workspace")
      ) {
        // Click in workspace-view but outside the workspace (grid area): Clear selection
        this.clearSelection();
      }
    });

    // Right-click on a workspace element opens the same magic menu at cursor location.
    this.addEventListener("contextmenu", (e) => {
      const item = e.target.closest(".designer-item");
      if (!item || e.target.closest(".magic-menu")) return;

      e.preventDefault();
      e.stopPropagation();

      const id = item.dataset.id;
      if (!this._selectedIds.has(id)) {
        this.selectElement(id, { clearExisting: true });
        this._selectionAnchor = id;
      }
      this._toggleMagicMenu(
        id,
        null,
        { x: e.clientX, y: e.clientY },
        true,
      );
    });

    window.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? this._settings.nudgeShiftStep : this._settings.nudgeStep;
      let handled = false;

      if (e.key === "Escape") {
        this.clearSelection();
        this._closeMagicMenu();
        handled = true;
      } else if ((e.ctrlKey || e.metaKey) && e.key === "a") {
        e.preventDefault();
        this.selectAll();
        handled = true;
      } else if (this._selectedIds.size > 0 && e.key === "Delete") {
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
      } else if (this._selectedIds.size > 0 && e.key === "ArrowLeft") {
        this.saveState();
        this.nudge(-step, 0);
        handled = true;
      } else if (this._selectedIds.size > 0 && e.key === "ArrowRight") {
        this.saveState();
        this.nudge(step, 0);
        handled = true;
      } else if (this._selectedIds.size > 0 && e.key === "ArrowUp") {
        this.saveState();
        this.nudge(0, -step);
        handled = true;
      } else if (this._selectedIds.size > 0 && e.key === "ArrowDown") {
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
        if (!this._selectedIds.has(id)) {
          this.selectElement(id, { clearExisting: true });
          this._selectionAnchor = id;
        }
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
          if (!this._selectedIds.has(id)) {
            this.selectElement(id, { clearExisting: true });
            this._selectionAnchor = id;
          }
          switch (action) {
            case "select-all-inside": this.selectAllInside(id); break;
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

    // Close menu on scroll or outside click, and clear selection when clicking outside
    window.addEventListener("mousedown", (e) => {
      if (!e.target.closest(".magic-menu") && !e.target.closest(".btn-item-trigger")) {
        this._closeMagicMenu();
      }
      
      // Clear selection when clicking outside the designer component
      if (!e.target.closest("bjl-designer")) {
        if (this._selectedIds.size > 0) {
          this.clearSelection();
        }
      }
    });

    const workspaceView = this.querySelector(".workspace-view");
    if (workspaceView) {
      workspaceView.addEventListener("scroll", () => this._closeMagicMenu(), true);
    }
  }

  _toggleMagicMenu(id, trigger = null, position = null, forceOpen = false) {
    const menu = this.querySelector("#magicMenu");
    if (!menu) return;

    const alreadyActive = menu.classList.contains("active") && this._magicMenuId === id;
    this._closeMagicMenu();

    if (alreadyActive && !forceOpen) return;

    this._magicMenuId = id;
    menu.classList.add("active");

    let left = 0;
    let top = 0;
    if (position) {
      left = position.x;
      top = position.y;
    } else if (trigger) {
      const rect = trigger.getBoundingClientRect();
      left = rect.right - 220;
      top = rect.top - 45;
    }

    // Keep the context menu inside viewport.
    const pad = 8;
    const menuRect = menu.getBoundingClientRect();
    const maxLeft = Math.max(pad, window.innerWidth - menuRect.width - pad);
    const maxTop = Math.max(pad, window.innerHeight - menuRect.height - pad);
    menu.style.left = `${Math.min(Math.max(left, pad), maxLeft)}px`;
    menu.style.top = `${Math.min(Math.max(top, pad), maxTop)}px`;
  }

  _closeMagicMenu() {
    const menu = this.querySelector("#magicMenu");
    if (menu) {
      menu.classList.remove("active");
    }
    this._magicMenuId = null;
  }

  /**
   * Select elements with multi-select support
   * @param {string|string[]} ids - ID or array of IDs to select
   * @param {Object} options - Selection options
   * @param {boolean} options.clearExisting - Clear existing selection (default: true)
   * @param {boolean} options.toggle - Toggle selection on/off (default: false)
   * @param {boolean} options.isRange - This is a range selection (default: false)
   */
  selectElement(ids, options = {}) {
    const { clearExisting = true, toggle = false, isRange = false } = options;
    
    // Handle single ID or array
    const idArray = Array.isArray(ids) ? ids : (ids ? [ids] : []);
    
    if (clearExisting && !toggle && !isRange) {
      this._selectedIds.clear();
    }
    
    // For range selection, get all IDs between anchor and target
    if (isRange && this._selectionAnchor && idArray.length === 1) {
      const targetId = idArray[0];
      const rangeIds = this._getRangeSelection(this._selectionAnchor, targetId);
      rangeIds.forEach(id => this._selectedIds.add(id));
    } else {
      // Normal or toggle selection
      idArray.forEach(id => {
        if (toggle) {
          if (this._selectedIds.has(id)) {
            this._selectedIds.delete(id);
          } else {
            this._selectedIds.add(id);
          }
        } else {
          this._selectedIds.add(id);
        }
      });
    }
    
    // Update last selected for range selection anchor
    if (idArray.length > 0) {
      this._lastSelectedId = idArray[idArray.length - 1];
    }
    
    this.updateWorkspace(true); // Hint: selection changed only
    this.dispatchEvent(new CustomEvent("selection-change", { 
      detail: { 
        ids: Array.from(this._selectedIds),
        count: this._selectedIds.size 
      } 
    }));

    // Auto-scroll to last selected element
    const lastId = idArray[idArray.length - 1];
    if (lastId && this._settings.autoScroll) {
      const el = this.querySelector(`.designer-item[data-id="${lastId}"]`);
      if (el) {
        el.scrollIntoView({
          behavior: "smooth",
          block: "center",
          inline: "center",
        });
      }
    }

    // Update tree - only sync single selection to avoid issues
    const tree = this.querySelector("#outlineTree");
    if (tree && this._selectedIds.size === 1) {
      tree.select(Array.from(this._selectedIds)[0]);
    }
  }

  /**
   * Get all element IDs in the workspace (for range selection)
   */
  _getAllElementIds() {
    if (!this._engine) return [];
    const layout = this._engine.getLayout();
    if (!layout || !layout.Data[':kids']) return [];
    return Object.values(layout.Data[':kids']).map(view => view.name);
  }

  /**
   * Get range of IDs between two elements
   */
  _getRangeSelection(fromId, toId) {
    const allIds = this._getAllElementIds();
    const fromIndex = allIds.indexOf(fromId);
    const toIndex = allIds.indexOf(toId);
    
    if (fromIndex === -1 || toIndex === -1) return [toId];
    
    const start = Math.min(fromIndex, toIndex);
    const end = Math.max(fromIndex, toIndex);
    
    return allIds.slice(start, end + 1);
  }

  /**
   * Clear all selections
   */
  clearSelection() {
    this._selectedIds.clear();
    this._lastSelectedId = null;
    this._selectionAnchor = null;
    this.updateWorkspace(true);
    const tree = this.querySelector("#outlineTree");
    if (tree) tree.select(null);
    this.dispatchEvent(new CustomEvent("selection-change", { 
      detail: { ids: [], count: 0 } 
    }));
  }

  /**
   * Select all elements
   */
  selectAll() {
    const allIds = this._getAllElementIds();
    this.selectElement(allIds, { clearExisting: true });
  }

  /**
   * Select a container element and all elements strictly inside its bounds.
   * This uses geometry only and does not depend on custom parent properties.
   */
  selectAllInside(id) {
    if (!id || !this._engine) return;
    const resolved = this._getResolvedLayoutState();
    const target = resolved.map.get(id);
    if (!target) return;

    const selected = new Set([id]);
    resolved.records.forEach((record) => {
      if (!record || record.id === id) return;
      if (
        record.left > target.left &&
        record.top > target.top &&
        record.right < target.right &&
        record.bottom < target.bottom
      ) {
        selected.add(record.id);
      }
    });

    this.selectElement(Array.from(selected), { clearExisting: true });
    this._selectionAnchor = id;
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
    if (this._selectedIds.size === 0) return;
    this.copy();
    this.deleteSelected();
    this._updateClipboardControls();
  }

  copy() {
    if (this._selectedIds.size === 0 || !this._engine) return;
    
    // Copy all selected elements
    const views = Array.from(this._selectedIds)
      .map(id => this._engine._findView(this._engine.getLayout().Data, id))
      .filter(view => view);
    
    if (views.length > 0) {
      // Store as array for multi-select support
      this._clipboard = views.map(view => JSON.parse(JSON.stringify(view)));
      this._updateClipboardControls();
    }
  }

  paste() {
    if (!this._clipboard || this._clipboard.length === 0 || !this._engine) return;
    this.saveState();

    // Ensure _clipboard is an array (backward compatibility)
    const clipboardArray = Array.isArray(this._clipboard) ? this._clipboard : [this._clipboard];
    const layout = this._engine.getLayout();
    if (!layout || !layout.Data) return;
    if (!layout.Data[":kids"]) layout.Data[":kids"] = {};

    const margin = Math.max(1, Number(this._engine.innerMargin) || this._snapGrid);
    const sourceItemsById = new Map(
      clipboardArray
        .filter((item) => item && item.name && item.variant0)
        .map((item, orderIndex) => [
          item.name,
          {
            item,
            orderIndex,
            left: Number(item.variant0.left) || 0,
            top: Number(item.variant0.top) || 0,
            width: Math.max(this._snapGrid, Number(item.variant0.width) || this._snapGrid),
            height: Math.max(this._snapGrid, Number(item.variant0.height) || this._snapGrid),
          },
        ]),
    );

    const sourceRecords = Array.from(sourceItemsById.entries()).map(([id, rec]) => ({
      id,
      orderIndex: rec.orderIndex,
      left: rec.left,
      top: rec.top,
      width: rec.width,
      height: rec.height,
      right: rec.left + rec.width,
      bottom: rec.top + rec.height,
      area: rec.width * rec.height,
      internalParentId: "",
    }));

    const strictlyContains = (outer, inner) =>
      inner.left > outer.left &&
      inner.top > outer.top &&
      inner.right < outer.right &&
      inner.bottom < outer.bottom;

    // Build internal hierarchy within the clipboard set itself.
    sourceRecords.forEach((child) => {
      const candidates = sourceRecords.filter(
        (candidate) =>
          candidate.id !== child.id && strictlyContains(candidate, child),
      );
      if (candidates.length === 0) return;
      const parent = candidates.sort((a, b) => {
        if (a.area !== b.area) return a.area - b.area;
        return a.orderIndex - b.orderIndex;
      })[0];
      child.internalParentId = parent.id;
    });

    const bySourceId = new Map(sourceRecords.map((r) => [r.id, r]));
    const depthMemo = new Map();
    const getDepth = (id) => {
      if (depthMemo.has(id)) return depthMemo.get(id);
      const rec = bySourceId.get(id);
      if (!rec || !rec.internalParentId) {
        depthMemo.set(id, 0);
        return 0;
      }
      const d = getDepth(rec.internalParentId) + 1;
      depthMemo.set(id, d);
      return d;
    };

    const pasteOrder = [...sourceRecords].sort((a, b) => {
      const depthA = getDepth(a.id);
      const depthB = getDepth(b.id);
      if (depthA !== depthB) return depthA - depthB; // parents first
      return a.orderIndex - b.orderIndex; // preserve original selection order
    });

    const sourceToNewId = new Map();
    const sourceToPlacedRect = new Map();
    const newIds = [];
    let rootIndex = 0;

    pasteOrder.forEach((source) => {
      const sourceEntry = sourceItemsById.get(source.id);
      if (!sourceEntry) return;

      const newItem = JSON.parse(JSON.stringify(sourceEntry.item));

      const shortType =
        newItem.shortType ||
        (newItem.customProperties && newItem.customProperties.shortType);
      let baseName = shortType;
      if (!baseName) baseName = newItem.name.split(/[0-9]/)[0].replace(/_$/, "");

      const newId = this._getNextId(baseName);
      newItem.name = newId;
      newItem.eventName = newId;
      if (newItem.customProperties) newItem.customProperties.eventName = newId;

      let expandContainerId = "";
      const sourceParentId = source.internalParentId;
      if (sourceParentId && sourceToNewId.has(sourceParentId)) {
        // Child of a selected source parent: place inside duplicated parent preserving relative offset.
        const newParentId = sourceToNewId.get(sourceParentId);
        const newParentRect = sourceToPlacedRect.get(sourceParentId);
        const sourceParentRect = bySourceId.get(sourceParentId);
        if (newParentRect && sourceParentRect) {
          const dx = source.left - sourceParentRect.left;
          const dy = source.top - sourceParentRect.top;
          newItem.variant0.left = newParentRect.left + dx;
          newItem.variant0.top = newParentRect.top + dy;
          expandContainerId = newParentId;
        }
      } else {
        // Root clipboard item: infer external parent from existing workspace geometry.
        const records = this._buildGeometryHierarchyRecords();
        const recordById = new Map(records.map((r) => [r.id, r]));
        const sourceRect = {
          left: source.left,
          top: source.top,
          width: source.width,
          height: source.height,
        };
        const parentId = this._inferParentForRect(sourceRect, records);

        if (parentId && recordById.has(parentId)) {
          const children = records
            .filter((r) => r.parentId === parentId)
            .sort((a, b) => a.orderIndex - b.orderIndex);

          if (children.length === 0) {
            const parent = recordById.get(parentId);
            newItem.variant0.left = parent.left + margin;
            newItem.variant0.top = parent.top + margin;
          } else {
            const lastChild = children[children.length - 1];
            newItem.variant0.left = lastChild.left;
            newItem.variant0.top = lastChild.bottom + margin;
          }
          expandContainerId = parentId;
        } else {
          // Root-level fallback: stagger only root items.
          newItem.variant0.left = source.left + 20 + (rootIndex * 10);
          newItem.variant0.top = source.top + 20 + (rootIndex * 10);
        }
        rootIndex++;
      }

      if (newItem.customProperties) {
        newItem.customProperties.Left = newItem.variant0.left;
        newItem.customProperties.Top = newItem.variant0.top;
        newItem.customProperties.Width =
          Number(newItem.variant0.width) || this._snapGrid;
        newItem.customProperties.Height =
          Number(newItem.variant0.height) || this._snapGrid;
      }

      // Add to root kids (insertion/z-order preserved by append order).
      layout.Data[":kids"][newId] = newItem;

      // Expand the duplicated/target parent if needed.
      if (expandContainerId) {
        const parentView = this._engine._findView(layout.Data, expandContainerId);
        if (parentView && parentView.variant0) {
          const childRight =
            newItem.variant0.left +
            (Number(newItem.variant0.width) || this._snapGrid) +
            margin;
          const childBottom =
            newItem.variant0.top +
            (Number(newItem.variant0.height) || this._snapGrid) +
            margin;
          const parentRight = parentView.variant0.left + parentView.variant0.width;
          const parentBottom = parentView.variant0.top + parentView.variant0.height;

          if (childRight > parentRight) {
            parentView.variant0.width = Math.max(
              this._snapGrid,
              childRight - parentView.variant0.left,
            );
            if (parentView.customProperties) {
              parentView.customProperties.Width = parentView.variant0.width;
            }
          }
          if (childBottom > parentBottom) {
            parentView.variant0.height = Math.max(
              this._snapGrid,
              childBottom - parentView.variant0.top,
            );
            if (parentView.customProperties) {
              parentView.customProperties.Height = parentView.variant0.height;
            }
          }
        }
      }

      sourceToNewId.set(source.id, newId);
      sourceToPlacedRect.set(source.id, {
        left: Number(newItem.variant0.left) || 0,
        top: Number(newItem.variant0.top) || 0,
        width: Math.max(this._snapGrid, Number(newItem.variant0.width) || this._snapGrid),
        height: Math.max(this._snapGrid, Number(newItem.variant0.height) || this._snapGrid),
      });
      newIds.push(newId);
    });

    // Select all pasted elements
    this.selectElement(newIds, { clearExisting: true });
    this.updateWorkspace();
    this._updateOutline();
    this._updateClipboardControls();
  }

  duplicate() {
    if (this._selectedIds.size === 0) return;
    this.copy();
    this.paste();
  }

  bringToFront() {
    if (this._selectedIds.size === 0 || !this._engine) return;
    this.saveState();

    try {
      // Apply z-order actions in geometry hierarchy order (parent -> child).
      const selectedIds = this._getSelectedIdsInParentChildOrder();
      selectedIds.forEach(id => {
        this._engine.bringToFront(id);
      });
      this.updateWorkspace();
      this._updateOutline();
    } catch (e) {
      console.error("Bring to Front failed:", e);
    }
  }

  sendToBack() {
    if (this._selectedIds.size === 0 || !this._engine) return;
    this.saveState();

    try {
      // Apply z-order actions in geometry hierarchy order (parent -> child).
      const selectedIds = this._getSelectedIdsInParentChildOrder();
      selectedIds.forEach(id => {
        this._engine.sendToBack(id);
      });
      this.updateWorkspace();
      this._updateOutline();
    } catch (e) {
      console.error("Send to Back failed:", e);
    }
  }

  deleteSelected() {
    if (this._selectedIds.size === 0) return;
    
    // Delete all selected elements
    const idsToDelete = Array.from(this._selectedIds);
    this.saveState();
    
    idsToDelete.forEach(id => {
      this._recursiveDelete(this._engine.getLayout().Data[":kids"], id);
    });
    
    this._selectedIds.clear();
    this.updateWorkspace();
    this._updateOutline();
    this.dispatchEvent(new CustomEvent("delete-element"));
  }

  _deleteElementInternal(id) {
    if (!this._engine || !id) return;

    this.saveState();
    this._recursiveDelete(this._engine.getLayout().Data[":kids"], id);
    this._selectedIds.delete(id);
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

  _updateTooltip(el, view, resolvedRect = null) {
    if (!el || !view) return;
    const top =
      resolvedRect && Number.isFinite(resolvedRect.top)
        ? resolvedRect.top
        : Number(view.variant0.top) || 0;
    const left =
      resolvedRect && Number.isFinite(resolvedRect.left)
        ? resolvedRect.left
        : Number(view.variant0.left) || 0;
    const width =
      resolvedRect && Number.isFinite(resolvedRect.width)
        ? resolvedRect.width
        : Number(view.variant0.width) || 0;
    const height =
      resolvedRect && Number.isFinite(resolvedRect.height)
        ? resolvedRect.height
        : Number(view.variant0.height) || 0;
    const tip = `Name: ${view.name}\nTop: ${top}\nLeft: ${left}\nWidth: ${width}\nHeight: ${height}`;
    el.setAttribute("data-tip", tip);
  }

  _triggerAutoSave() {
    if (this._autoSaveTimer) clearTimeout(this._autoSaveTimer);

    const status = this.querySelector("#saveStatus");
    if (status) {
      status.style.opacity = "1";
      status.innerHTML = `<i class="ri-loader-4-line animate-spin text-primary"></i> <span>Saving...</span>`;
    }

    if (this._settings.autoSaveInterval === 0) return;

    this._autoSaveTimer = setTimeout(() => {
      this._autoSave();
    }, this._settings.autoSaveInterval);
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
    try {
      const skipRestoreOnce = sessionStorage.getItem("bjl_skip_restore_once");
      if (skipRestoreOnce === "1") {
        sessionStorage.removeItem("bjl_skip_restore_once");
        localStorage.removeItem("bjl_draft");
        return;
      }
    } catch (e) {
      console.warn("Restore guard unavailable:", e);
    }

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

  _loadSettings() {
    const saved = localStorage.getItem("bjl_designer_settings");
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        this._settings = { ...this._defaultSettings, ...parsed };
      } catch (e) {
        console.error("Failed to load settings:", e);
      }
    }
  }

  _saveSettings() {
    localStorage.setItem("bjl_designer_settings", JSON.stringify(this._settings));
  }

  _showSettings() {
    try {
      const modal = this.querySelector("#modalSettings");
      if (!modal) {
        console.error("Settings modal not found");
        return;
      }
      
      // Close any open dropdowns first
      const dropdowns = this.querySelectorAll('.dropdown-content');
      dropdowns.forEach(d => d.blur());
      
      // Sync UI with current settings
      const setShowGrid = this.querySelector("#set_showGrid");
      const setSnapDensity = this.querySelector("#set_snapDensity");
      const setShowTooltips = this.querySelector("#set_showTooltips");
      const setShowLabels = this.querySelector("#set_showLabels");
      const setSelectionColor = this.querySelector("#set_selectionColor");
      const setInitialZoom = this.querySelector("#set_initialZoom");
      const setNudgeStep = this.querySelector("#set_nudgeStep");
      const setNudgeShiftStep = this.querySelector("#set_nudgeShiftStep");
      const setAutoScroll = this.querySelector("#set_autoScroll");
      const setAutoSaveInterval = this.querySelector("#set_autoSaveInterval");
      
      if (setShowGrid) setShowGrid.checked = this._settings.showGrid;
      if (setSnapDensity) setSnapDensity.value = this._settings.snapDensity;
      if (setShowTooltips) setShowTooltips.checked = this._settings.showTooltips;
      if (setShowLabels) setShowLabels.checked = this._settings.showLabels;
      if (setSelectionColor) setSelectionColor.value = this._settings.selectionColor;
      if (setInitialZoom) setInitialZoom.value = this._settings.initialZoom;
      if (setNudgeStep) setNudgeStep.value = this._settings.nudgeStep;
      if (setNudgeShiftStep) setNudgeShiftStep.value = this._settings.nudgeShiftStep;
      if (setAutoScroll) setAutoScroll.checked = this._settings.autoScroll;
      if (setAutoSaveInterval) setAutoSaveInterval.value = this._settings.autoSaveInterval;

      modal.showModal();

      // Bind apply button
      const btnApply = this.querySelector("#btnApplySettings");
      if (btnApply) {
        btnApply.onclick = () => {
          this._applySettings();
          modal.close();
        };
      }
    } catch (error) {
      console.error("Error showing settings:", error);
    }
  }

  _applySettings() {
    this._settings.showGrid = this.querySelector("#set_showGrid").checked;
    this._settings.snapDensity = parseInt(this.querySelector("#set_snapDensity").value);
    this._settings.showTooltips = this.querySelector("#set_showTooltips").checked;
    this._settings.showLabels = this.querySelector("#set_showLabels").checked;
    this._settings.selectionColor = this.querySelector("#set_selectionColor").value;
    this._settings.initialZoom = parseInt(this.querySelector("#set_initialZoom").value);
    this._settings.nudgeStep = parseInt(this.querySelector("#set_nudgeStep").value);
    this._settings.nudgeShiftStep = parseInt(this.querySelector("#set_nudgeShiftStep").value);
    this._settings.autoScroll = this.querySelector("#set_autoScroll").checked;
    this._settings.autoSaveInterval = parseInt(this.querySelector("#set_autoSaveInterval").value);

    // Update class properties
    this._showGrid = this._settings.showGrid;
    this._snapGrid = this._settings.snapDensity;
    
    // Apply Selection Color
    this.style.setProperty("--selection-color", this._settings.selectionColor);
    
    // Update Reset Zoom tooltip
    const resetZoomTooltip = this.querySelector("#resetZoomTooltip");
    if (resetZoomTooltip) {
      resetZoomTooltip.setAttribute("data-tip", `Reset Zoom (${this._settings.initialZoom}%)`);
    }

    this._saveSettings();
    this.updateWorkspace();
    this._updateOutline();

    Swal.fire({
      icon: "success",
      title: "Settings Applied",
      toast: true,
      position: "top-end",
      showConfirmButton: false,
      timer: 2000
    });
  }

  nudge(dx, dy) {
    if (this._selectedIds.size === 0 || !this._engine) return;
    const resolvedState = this._getResolvedLayoutState();
    const fallbackParentRect = resolvedState.rootRect || {
      left: 0,
      top: 0,
      width: this._getWorkspaceBaseSize().width,
      height: this._getWorkspaceBaseSize().height,
    };

    const nudgeData = Array.from(this._selectedIds)
      .map((id) => {
        const record = resolvedState.map.get(id);
        const view =
          (record && record.view) ||
          this._engine._findView(this._engine.getLayout().Data, id);
        if (!record || !view || !view.variant0) return null;
        const parentRectSource = record.parentRect || fallbackParentRect;
        return {
          id,
          view,
          parentId: record.parentId || "",
          parentRect: {
            left: Number(parentRectSource.left) || 0,
            top: Number(parentRectSource.top) || 0,
            width: Number(parentRectSource.width) || 0,
            height: Number(parentRectSource.height) || 0,
          },
          rect: {
            left: (Number(record.left) || 0) + dx,
            top: (Number(record.top) || 0) + dy,
            width: Number(record.width) || 0,
            height: Number(record.height) || 0,
          },
        };
      })
      .filter((item) => item !== null);

    if (nudgeData.length === 0) return;
    const nextRects = new Map(nudgeData.map((item) => [item.id, item.rect]));

    nudgeData.forEach((item) => {
      const parentRect =
        item.parentId && nextRects.has(item.parentId)
          ? nextRects.get(item.parentId)
          : item.parentRect;
      this._applyResolvedRectToVariant(item.view.variant0, parentRect, item.rect, {
        snap: false,
      });
      if (item.view.customProperties) {
        item.view.customProperties.Left = item.view.variant0.left;
        item.view.customProperties.Top = item.view.variant0.top;
        item.view.customProperties.Width = item.view.variant0.width;
        item.view.customProperties.Height = item.view.variant0.height;
      }
    });

    this.updateWorkspace();
  }

  _updateOutline() {
    const tree = this.querySelector("#outlineTree");
    if (!tree || !this._engine) return;

    const layout = this._engine.getLayout();
    if (!layout || !layout.Data[":kids"]) {
      tree.clear();
      return;
    }

    const nodes = this._buildOutlineNodesFromGeometry();
    tree.clear();
    nodes.forEach((node) => {
      tree.addNode(
        node.parentId || "",
        node.id,
        node.id,
        this._getColor(node.id),
        "",
      );
    });

    if (this._selectedId) tree.select(this._selectedId);
  }

  _getViewsInLayoutOrder() {
    return this._getResolvedLayoutState().records.map((r) => r.view);
  }

  _buildGeometryHierarchyRecords() {
    const resolved = this._getResolvedLayoutState();
    const records = resolved.records.map((record) => ({
      id: record.id,
      orderIndex: record.orderIndex,
      left: record.left,
      top: record.top,
      width: record.width,
      height: record.height,
      right: record.right,
      bottom: record.bottom,
      area: record.area,
      parentId: "",
    }));

    const strictlyContains = (outer, inner) =>
      inner.left > outer.left &&
      inner.top > outer.top &&
      inner.right < outer.right &&
      inner.bottom < outer.bottom;

    records.forEach((child) => {
      const candidates = records.filter(
        (candidate) =>
          candidate.id !== child.id && strictlyContains(candidate, child),
      );
      if (candidates.length === 0) return;

      const parent = candidates.sort((a, b) => {
        if (a.area !== b.area) return a.area - b.area;
        return a.orderIndex - b.orderIndex;
      })[0];
      child.parentId = parent.id;
    });

    return records;
  }

  _inferParentForRect(rect, records) {
    if (!rect || !records || records.length === 0) return "";
    const inner = {
      left: Number(rect.left) || 0,
      top: Number(rect.top) || 0,
      right: (Number(rect.left) || 0) + (Number(rect.width) || 0),
      bottom: (Number(rect.top) || 0) + (Number(rect.height) || 0),
    };
    const candidates = records.filter(
      (outer) =>
        inner.left > outer.left &&
        inner.top > outer.top &&
        inner.right < outer.right &&
        inner.bottom < outer.bottom,
    );
    if (candidates.length === 0) return "";
    const parent = candidates.sort((a, b) => {
      if (a.area !== b.area) return a.area - b.area;
      return a.orderIndex - b.orderIndex;
    })[0];
    return parent.id;
  }

  _buildOutlineNodesFromGeometry() {
    const records = this._buildGeometryHierarchyRecords();

    const childrenByParent = new Map();
    const rootKey = "";
    childrenByParent.set(rootKey, []);
    records.forEach((record) => {
      const parentId = record.parentId || rootKey;
      if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
      childrenByParent.get(parentId).push(record);
    });
    childrenByParent.forEach((items) =>
      items.sort((a, b) => a.orderIndex - b.orderIndex),
    );

    const output = [];
    const walk = (parentId) => {
      const children = childrenByParent.get(parentId) || [];
      children.forEach((child) => {
        output.push({ id: child.id, parentId });
        walk(child.id);
      });
    };
    walk(rootKey);

    return output;
  }

  _getGeometrySubtreeIds(rootId) {
    if (!rootId) return [];
    const records = this._buildGeometryHierarchyRecords();
    const existing = new Set(records.map((r) => r.id));
    if (!existing.has(rootId)) return [rootId];

    const childrenByParent = new Map();
    records.forEach((record) => {
      const parentId = record.parentId || "";
      if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
      childrenByParent.get(parentId).push(record.id);
    });

    const out = [];
    const walk = (id) => {
      out.push(id);
      (childrenByParent.get(id) || []).forEach((childId) => walk(childId));
    };
    walk(rootId);
    return out;
  }

  _getSelectedIdsInParentChildOrder() {
    if (this._selectedIds.size === 0) return [];

    const records = this._buildGeometryHierarchyRecords();
    const selected = new Set(this._selectedIds);
    const childrenByParent = new Map();

    records.forEach((record) => {
      const parentId = record.parentId || "";
      if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
      childrenByParent.get(parentId).push(record);
    });
    childrenByParent.forEach((items) =>
      items.sort((a, b) => a.orderIndex - b.orderIndex),
    );

    const ordered = [];
    const visited = new Set();
    const walk = (parentId) => {
      const children = childrenByParent.get(parentId) || [];
      children.forEach((child) => {
        if (selected.has(child.id) && !visited.has(child.id)) {
          ordered.push(child.id);
          visited.add(child.id);
        }
        walk(child.id);
      });
    };
    walk("");

    // Include any selected ids that do not appear in geometry records.
    Array.from(this._selectedIds).forEach((id) => {
      if (!visited.has(id)) ordered.push(id);
    });

    return ordered;
  }

  startResizing(e, dir) {
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;

    const selectedIds = Array.from(this._selectedIds);
    if (selectedIds.length === 0) return;

    const resolvedState = this._getResolvedLayoutState();
    const fallbackParentRect = resolvedState.rootRect || {
      left: 0,
      top: 0,
      width: this._getWorkspaceBaseSize().width,
      height: this._getWorkspaceBaseSize().height,
    };

    const resizeData = selectedIds
      .map((id) => {
        const view = this._engine._findView(this._engine.getLayout().Data, id);
        if (!view || !view.variant0) return null;
        const record = resolvedState.map.get(id);
        const parentRectSource =
          (record && record.parentRect) || fallbackParentRect;
        return {
          id,
          view,
          parentId: (record && record.parentId) || "",
          parentRect: {
            left: Number(parentRectSource.left) || 0,
            top: Number(parentRectSource.top) || 0,
            width: Number(parentRectSource.width) || 0,
            height: Number(parentRectSource.height) || 0,
          },
          initialLeft:
            record && Number.isFinite(record.left)
              ? Number(record.left)
              : Number(view.variant0.left) || 0,
          initialTop:
            record && Number.isFinite(record.top)
              ? Number(record.top)
              : Number(view.variant0.top) || 0,
          initialWidth:
            record && Number.isFinite(record.width)
              ? Math.max(this._snapGrid, Number(record.width))
              : Math.max(this._snapGrid, Number(view.variant0.width) || this._snapGrid),
          initialHeight:
            record && Number.isFinite(record.height)
              ? Math.max(this._snapGrid, Number(record.height))
              : Math.max(this._snapGrid, Number(view.variant0.height) || this._snapGrid),
          el: this.querySelector(`.designer-item[data-id="${id}"]`),
        };
      })
      .filter((item) => item !== null);
    if (resizeData.length === 0) return;

    const isMultiResize = resizeData.length > 1;
    const resizeDataById = new Map(resizeData.map((item) => [item.id, item]));
    const groupBounds = isMultiResize
      ? (() => {
          const left = Math.min(...resizeData.map((item) => item.initialLeft));
          const top = Math.min(...resizeData.map((item) => item.initialTop));
          const right = Math.max(
            ...resizeData.map((item) => item.initialLeft + item.initialWidth),
          );
          const bottom = Math.max(
            ...resizeData.map((item) => item.initialTop + item.initialHeight),
          );
          return {
            left,
            top,
            right,
            bottom,
            width: Math.max(this._snapGrid, right - left),
            height: Math.max(this._snapGrid, bottom - top),
          };
        })()
      : null;
    const containmentConstraints = [];
    if (isMultiResize) {
      // Build containment constraints purely from geometry.
      // If a selected view starts strictly inside another selected view, keep a non-zero inset.
      const isStrictlyInside = (inner, outer) =>
        inner.initialLeft > outer.initialLeft &&
        inner.initialTop > outer.initialTop &&
        inner.initialLeft + inner.initialWidth < outer.initialLeft + outer.initialWidth &&
        inner.initialTop + inner.initialHeight < outer.initialTop + outer.initialHeight;

      resizeData.forEach((child) => {
        const parentCandidates = resizeData.filter(
          (candidate) => candidate.id !== child.id && isStrictlyInside(child, candidate),
        );
        if (parentCandidates.length === 0) return;

        // Use the nearest containing parent (smallest area) for direct containment.
        const parent = parentCandidates.sort(
          (a, b) =>
            a.initialWidth * a.initialHeight - b.initialWidth * b.initialHeight,
        )[0];

        const leftInset = child.initialLeft - parent.initialLeft;
        const topInset = child.initialTop - parent.initialTop;
        const rightInset =
          parent.initialLeft + parent.initialWidth - (child.initialLeft + child.initialWidth);
        const bottomInset =
          parent.initialTop + parent.initialHeight - (child.initialTop + child.initialHeight);

        if (leftInset > 0 && topInset > 0 && rightInset > 0 && bottomInset > 0) {
          containmentConstraints.push({
            containerId: parent.id,
            childId: child.id,
            minInset: this._snapGrid,
          });
        }
      });
    }

    const onMouseMove = (moveE) => {
      const dx = (moveE.clientX - startX) / this._scale;
      const dy = (moveE.clientY - startY) / this._scale;

      if (isMultiResize) {
        resizeData.forEach((item) => {
          if (item.el) item.el.classList.add("resizing");
        });
        this.resizeSelectionGroup(
          dir,
          resizeData,
          groupBounds,
          dx,
          dy,
          containmentConstraints,
        );
      } else {
        const item = resizeData[0];
        if (item.el) item.el.classList.add("resizing");
        this.resize(
          dir,
          item.view,
          item.el,
          item.initialLeft,
          item.initialTop,
          item.initialWidth,
          item.initialHeight,
          item.parentRect,
          dx,
          dy,
        );
      }
    };

    const onMouseUp = () => {
      resizeData.forEach((item) => {
        if (item.el) item.el.classList.remove("resizing");
      });
      this.updateWorkspace();
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }

  resizeSelectionGroup(
    dir,
    resizeData,
    initialBounds,
    dx,
    dy,
    containmentConstraints = [],
  ) {
    if (!resizeData || resizeData.length === 0 || !initialBounds) return;
    const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
    const snap = (value) => this._snapValue(value);
    const itemById = new Map(resizeData.map((item) => [item.id, item]));

    let nextLeft = initialBounds.left;
    let nextTop = initialBounds.top;
    let nextRight = initialBounds.right;
    let nextBottom = initialBounds.bottom;

    if (dir.includes("e")) {
      nextRight = snap(initialBounds.right + dx);
    }
    if (dir.includes("s")) {
      nextBottom = snap(initialBounds.bottom + dy);
    }
    if (dir.includes("w")) {
      nextLeft = snap(initialBounds.left + dx);
    }
    if (dir.includes("n")) {
      nextTop = snap(initialBounds.top + dy);
    }

    if (nextRight - nextLeft < this._snapGrid) {
      if (dir.includes("w")) {
        nextLeft = nextRight - this._snapGrid;
      } else {
        nextRight = nextLeft + this._snapGrid;
      }
    }
    if (nextBottom - nextTop < this._snapGrid) {
      if (dir.includes("n")) {
        nextTop = nextBottom - this._snapGrid;
      } else {
        nextBottom = nextTop + this._snapGrid;
      }
    }

    const nextWidth = Math.max(this._snapGrid, nextRight - nextLeft);
    const nextHeight = Math.max(this._snapGrid, nextBottom - nextTop);
    const resizeX = dir.includes("e") || dir.includes("w");
    const resizeY = dir.includes("n") || dir.includes("s");
    const nextRects = new Map();

    resizeData.forEach((item) => {
      let left = item.initialLeft;
      let top = item.initialTop;
      let width = item.initialWidth;
      let height = item.initialHeight;

      if (resizeX) {
        const startLeftNorm = (item.initialLeft - initialBounds.left) / initialBounds.width;
        const startRightNorm =
          (item.initialLeft + item.initialWidth - initialBounds.left) / initialBounds.width;
        const scaledLeft = nextLeft + startLeftNorm * nextWidth;
        const scaledRight = nextLeft + startRightNorm * nextWidth;
        left = snap(scaledLeft);
        width = Math.max(this._snapGrid, snap(scaledRight - scaledLeft));
      }

      if (resizeY) {
        const startTopNorm = (item.initialTop - initialBounds.top) / initialBounds.height;
        const startBottomNorm =
          (item.initialTop + item.initialHeight - initialBounds.top) / initialBounds.height;
        const scaledTop = nextTop + startTopNorm * nextHeight;
        const scaledBottom = nextTop + startBottomNorm * nextHeight;
        top = snap(scaledTop);
        height = Math.max(this._snapGrid, snap(scaledBottom - scaledTop));
      }

      nextRects.set(item.id, { left, top, width, height });
    });

    // Enforce that initially-contained selected children stay inset from selected parent edges.
    containmentConstraints.forEach((constraint) => {
      const parent = itemById.get(constraint.containerId);
      const child = itemById.get(constraint.childId);
      if (!parent || !child) return;

      const parentRect = nextRects.get(parent.id);
      const childRect = nextRects.get(child.id);
      if (!parentRect || !childRect) return;
      const minInset = Math.max(this._snapGrid, constraint.minInset || 0);
      const parentLeft = parentRect.left;
      const parentTop = parentRect.top;
      const parentRight = parentRect.left + parentRect.width;
      const parentBottom = parentRect.top + parentRect.height;

      // If parent gets too small, relax inset to stay geometrically valid.
      const insetX = Math.min(
        minInset,
        Math.max(0, (parentRect.width - this._snapGrid) / 2),
      );
      const insetY = Math.min(
        minInset,
        Math.max(0, (parentRect.height - this._snapGrid) / 2),
      );
      const minLeft = parentLeft + insetX;
      const minTop = parentTop + insetY;
      const maxRight = parentRight - insetX;
      const maxBottom = parentBottom - insetY;

      const maxChildWidth = Math.max(this._snapGrid, maxRight - minLeft);
      const maxChildHeight = Math.max(this._snapGrid, maxBottom - minTop);

      let childWidth = Math.min(childRect.width, maxChildWidth);
      let childHeight = Math.min(childRect.height, maxChildHeight);
      let childLeft = childRect.left;
      let childTop = childRect.top;

      childLeft = clamp(childLeft, minLeft, maxRight - childWidth);
      childTop = clamp(childTop, minTop, maxBottom - childHeight);

      childRect.left = snap(childLeft);
      childRect.top = snap(childTop);
      childRect.width = Math.max(this._snapGrid, snap(childWidth));
      childRect.height = Math.max(this._snapGrid, snap(childHeight));

      // Final safety clamp after snapping to prevent any boundary collision.
      if (childRect.left < minLeft) childRect.left = minLeft;
      if (childRect.top < minTop) childRect.top = minTop;
      if (childRect.left + childRect.width > maxRight) {
        childRect.width = Math.max(this._snapGrid, maxRight - childRect.left);
      }
      if (childRect.top + childRect.height > maxBottom) {
        childRect.height = Math.max(this._snapGrid, maxBottom - childRect.top);
      }
    });

    resizeData.forEach((item) => {
      const rect = nextRects.get(item.id);
      const parentRect = item.parentId && nextRects.has(item.parentId)
        ? nextRects.get(item.parentId)
        : item.parentRect;
      if (!rect || !item.view?.variant0 || !parentRect) return;
      this._applyResolvedRectToVariant(item.view.variant0, parentRect, rect);
    });

    const resolvedAfter = this._getResolvedLayoutState().map;
    resizeData.forEach((item) => {
      const v0 = item.view.variant0;
      if (!v0) return;
      if (item.view.customProperties) {
        item.view.customProperties.Left = v0.left;
        item.view.customProperties.Top = v0.top;
        item.view.customProperties.Width = v0.width;
        item.view.customProperties.Height = v0.height;
      }

      if (item.el) {
        const resolved = resolvedAfter.get(item.id);
        const left = resolved ? resolved.left : v0.left;
        const top = resolved ? resolved.top : v0.top;
        const width = resolved ? resolved.width : v0.width;
        const height = resolved ? resolved.height : v0.height;
        item.el.style.left = `${left * this._scale}px`;
        item.el.style.top = `${top * this._scale}px`;
        item.el.style.width = `${width * this._scale}px`;
        item.el.style.height = `${height * this._scale}px`;
        this._updateTooltip(item.el, item.view, resolved || null);
      }
    });
  }

  startDragging(e, id) {
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    
    // Get all selected elements to drag together
    const selectedIds = Array.from(this._selectedIds);
    if (!selectedIds.includes(id)) {
      // If clicked element is not in selection, select it alone
      this.selectElement(id);
      selectedIds.push(id);
    }

    const resolvedState = this._getResolvedLayoutState();
    const fallbackParentRect = resolvedState.rootRect || {
      left: 0,
      top: 0,
      width: this._getWorkspaceBaseSize().width,
      height: this._getWorkspaceBaseSize().height,
    };

    // Store initial resolved geometry for all selected elements.
    const dragData = selectedIds
      .map((selectedId) => {
        const view = this._engine._findView(
          this._engine.getLayout().Data,
          selectedId,
        );
        if (!view || !view.variant0) return null;
        const record = resolvedState.map.get(selectedId);
        const parentRectSource = (record && record.parentRect) || fallbackParentRect;
        return {
          id: selectedId,
          view,
          parentId: (record && record.parentId) || "",
          parentRect: {
            left: Number(parentRectSource.left) || 0,
            top: Number(parentRectSource.top) || 0,
            width: Number(parentRectSource.width) || 0,
            height: Number(parentRectSource.height) || 0,
          },
          initialLeft:
            record && Number.isFinite(record.left)
              ? Number(record.left)
              : Number(view.variant0.left) || 0,
          initialTop:
            record && Number.isFinite(record.top)
              ? Number(record.top)
              : Number(view.variant0.top) || 0,
          initialWidth:
            record && Number.isFinite(record.width)
              ? Number(record.width)
              : Number(view.variant0.width) || 0,
          initialHeight:
            record && Number.isFinite(record.height)
              ? Number(record.height)
              : Number(view.variant0.height) || 0,
          el: this.querySelector(`.designer-item[data-id="${selectedId}"]`),
        };
      })
      .filter((item) => item !== null);

    let moved = false;
    const threshold = 5;
    const snap = (value) => this._snapValue(value);

    const onMouseMove = (moveE) => {
      const dx = (moveE.clientX - startX) / this._scale;
      const dy = (moveE.clientY - startY) / this._scale;

      if (Math.abs(dx) > threshold || Math.abs(dy) > threshold) {
        if (!moved) {
          this.saveState();
          moved = true;
        }

        // Apply movement in resolved space first, then map back to variant coordinates.
        const nextRects = new Map();
        dragData.forEach((item) => {
          nextRects.set(item.id, {
            left: snap(item.initialLeft + dx),
            top: snap(item.initialTop + dy),
            width: item.initialWidth,
            height: item.initialHeight,
          });
        });

        dragData.forEach((item) => {
          if (item.el) item.el.classList.add("dragging");
          const rect = nextRects.get(item.id);
          const parentRect =
            item.parentId && nextRects.has(item.parentId)
              ? nextRects.get(item.parentId)
              : item.parentRect;
          this.drag(item.view, rect, parentRect);
        });

        const resolvedAfter = this._getResolvedLayoutState().map;
        dragData.forEach((item) => {
          if (!item.el) return;
          const resolved = resolvedAfter.get(item.id);
          const left = resolved ? resolved.left : item.initialLeft;
          const top = resolved ? resolved.top : item.initialTop;
          item.el.style.left = `${left * this._scale}px`;
          item.el.style.top = `${top * this._scale}px`;
          this._updateTooltip(item.el, item.view, resolved || null);
        });
      }
    };

    const onMouseUp = () => {
      dragData.forEach(item => {
        if (item.el) item.el.classList.remove("dragging");
      });

      if (!moved) {
        // It was a click -> Toggle selection (if Ctrl/Cmd not held)
        if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
          this.selectElement(id, { clearExisting: true });
        }
      }

      // Update workspace
      this.updateWorkspace();
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }

  drag(view, resolvedRect, parentRect) {
    if (!view || !view.variant0 || !resolvedRect || !parentRect) return;
    this._applyResolvedRectToVariant(view.variant0, parentRect, resolvedRect);

    if (view.customProperties) {
      view.customProperties.Left = view.variant0.left;
      view.customProperties.Top = view.variant0.top;
      view.customProperties.Width = view.variant0.width;
      view.customProperties.Height = view.variant0.height;
    }
  }

  toggleSelection(id) {
    // Use toggle option for multi-select support
    this.selectElement(id, { toggle: true, clearExisting: false });
  }

  resize(
    dir,
    view,
    el,
    initialLeft,
    initialTop,
    initialWidth,
    initialHeight,
    parentRect,
    dx,
    dy,
  ) {
    if (!view || !view.variant0 || !parentRect) return;
    const v0 = view.variant0;
    const snap = (value) => this._snapValue(value);

    let nextLeft = initialLeft;
    let nextTop = initialTop;
    let nextRight = initialLeft + initialWidth;
    let nextBottom = initialTop + initialHeight;

    if (dir.includes("e")) nextRight = snap(initialLeft + initialWidth + dx);
    if (dir.includes("s")) nextBottom = snap(initialTop + initialHeight + dy);
    if (dir.includes("w")) nextLeft = snap(initialLeft + dx);
    if (dir.includes("n")) nextTop = snap(initialTop + dy);

    if (nextRight - nextLeft < this._snapGrid) {
      if (dir.includes("w")) {
        nextLeft = nextRight - this._snapGrid;
      } else {
        nextRight = nextLeft + this._snapGrid;
      }
    }
    if (nextBottom - nextTop < this._snapGrid) {
      if (dir.includes("n")) {
        nextTop = nextBottom - this._snapGrid;
      } else {
        nextBottom = nextTop + this._snapGrid;
      }
    }

    this._applyResolvedRectToVariant(v0, parentRect, {
      left: nextLeft,
      top: nextTop,
      width: Math.max(this._snapGrid, nextRight - nextLeft),
      height: Math.max(this._snapGrid, nextBottom - nextTop),
    });

    if (view.customProperties) {
      view.customProperties.Left = v0.left;
      view.customProperties.Top = v0.top;
      view.customProperties.Width = v0.width;
      view.customProperties.Height = v0.height;
    }

    // Update visual dimensions with scale applied
    if (el) {
      const resolved = this._getResolvedLayoutState().map.get(view.name);
      const left = resolved ? resolved.left : v0.left;
      const top = resolved ? resolved.top : v0.top;
      const width = resolved ? resolved.width : v0.width;
      const height = resolved ? resolved.height : v0.height;
      el.style.left = `${left * this._scale}px`;
      el.style.top = `${top * this._scale}px`;
      el.style.width = `${width * this._scale}px`;
      el.style.height = `${height * this._scale}px`;
      this._updateTooltip(el, view, resolved || null);
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
    this._syncEngineVariantBoundsFromLayout();
    this._applyWorkspaceScalerSize();
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

    // Update scaler dimensions directly from primary variant (this affects scroll size)
    const base = this._getWorkspaceBaseSize();
    scaler.style.width = `${base.width * this._scale}px`;
    scaler.style.height = `${base.height * this._scale}px`;

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
      this._applyWorkspaceScalerSize();
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
    const workspaceBase = this._getWorkspaceBaseSize();

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
                }
                .designer-item.dragging, .designer-item.resizing {
                    transition: none !important;
                }
                .designer-item.selected, .designer-item.dragging {
                    outline: 2.5px solid var(--selection-color, #3b82f6); 
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
                    /* Keep JSONEditor default contrast so sprite icons stay visible */
                    background-color: #3883fa !important;
                    border-bottom: 1px solid #2f6fd4 !important;
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
            
            <div class="designer-container ${themeClass}">
                <div class="main-toolbar">
                    <div class="flex items-center gap-2">
                        <!-- File Dropdown -->
                        <div id="fileDropdown" class="dropdown">
                            <label tabindex="0" class="btn btn-sm btn-ghost gap-2 rounded-full px-4">
                                <i class="ri-file-list-3-line text-lg"></i>
                                <span>File</span>
                                <i class="ri-arrow-down-s-line"></i>
                            </label>
                            <ul id="fileDropdownMenu" tabindex="0" class="dropdown-content menu p-2 shadow bg-base-100 rounded-box w-52 z-[100]">
                                <li>
                                    <a id="btnImport">
                                        <i class="ri-upload-2-line"></i> Import BJL/BAL
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
                                        <i class="ri-download-2-line"></i> Export BJL/BAL
                                    </a>
                                </li>
                                <li>
                                    <a id="btnExportJson">
                                        <i class="ri-code-s-slash-line"></i> Export JSON
                                    </a>
                                </li>
                                <div class="divider my-0 opacity-10"></div>
                                <li>
                                    <a id="btnSave">
                                        <i class="ri-save-line"></i> Save
                                    </a>
                                </li>
                                <li>
                                    <a id="btnSaveAs">
                                        <i class="ri-save-3-line"></i> Save As
                                    </a>
                                </li>
                                <div class="divider my-0 opacity-10"></div>
                                <li>
                                    <a id="btnSettings">
                                        <i class="ri-settings-3-line"></i> Settings
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
                        <input type="file" id="fileImport" accept=".bjl,.bal" style="display: none;">
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
                            <div class="tooltip tooltip-left tooltip-primary" id="resetZoomTooltip" data-tip="Reset Zoom (${this._settings.initialZoom}%)">
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
                        <bjl-tree id="outlineTree" class="flex-1"></bjl-tree>
                    </div>

                    <div class="workspace-view">
                        <div class="workspace-wrapper">
                            <div class="workspace-board">
                                <div class="workspace-scaler" style="width: ${workspaceBase.width * this._scale}px; height: ${workspaceBase.height * this._scale}px;">
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

            <!-- Settings Modal -->
            <dialog id="modalSettings" class="modal">
                <div class="modal-box w-11/12 max-w-2xl bg-base-100/90 backdrop-blur-xl border border-base-content/10 shadow-2xl">
                    <div class="flex items-center gap-3 mb-6">
                        <div class="w-10 h-10 rounded-xl bg-primary/20 flex items-center justify-center text-primary">
                            <i class="ri-settings-3-fill text-2xl"></i>
                        </div>
                        <div>
                            <h3 class="font-black text-xl tracking-tight">Designer Settings</h3>
                            <p class="text-[10px] uppercase font-bold opacity-40">Configure your workspace environment</p>
                        </div>
                    </div>

                    <div class="overflow-x-auto">
                        <table class="table w-full border-0">
                            <tbody class="border-0 divide-y-0">
                                <tr class="border-0 py-2">
                                    <td class="border-0 py-2">Show Grid</td>
                                    <td class="border-0 py-2"><input type="checkbox" id="set_showGrid" class="toggle toggle-primary" ${this._settings.showGrid ? "checked" : ""}></td>
                                </tr>
                                <tr class="border-0 py-2">
                                    <td class="border-0 py-2">Snap Density (px)</td>
                                    <td class="border-0 py-2">
                                        <select id="set_snapDensity" class="select select-bordered w-full">
                                            <option value="1" ${this._settings.snapDensity === 1 ? "selected" : ""}>1 (Off)</option>
                                            <option value="5" ${this._settings.snapDensity === 5 ? "selected" : ""}>5</option>
                                            <option value="10" ${this._settings.snapDensity === 10 ? "selected" : ""}>10 (Standard)</option>
                                            <option value="20" ${this._settings.snapDensity === 20 ? "selected" : ""}>20</option>
                                        </select>
                                    </td>
                                </tr>
                                <tr class="border-0 py-2">
                                    <td class="border-0 py-2">Show Tooltips</td>
                                    <td class="border-0 py-2"><input type="checkbox" id="set_showTooltips" class="toggle toggle-primary" ${this._settings.showTooltips ? "checked" : ""}></td>
                                </tr>
                                <tr class="border-0 py-2">
                                    <td class="border-0 py-2">Show Labels</td>
                                    <td class="border-0 py-2"><input type="checkbox" id="set_showLabels" class="toggle toggle-primary" ${this._settings.showLabels ? "checked" : ""}></td>
                                </tr>
                                <tr class="border-0 py-2">
                                    <td class="border-0 py-2">Selection Color</td>
                                    <td class="border-0 py-2"><input type="color" id="set_selectionColor" class="input input-bordered w-full h-10 p-1" value="${this._settings.selectionColor}"></td>
                                </tr>
                                <tr class="border-0 py-2">
                                    <td class="border-0 py-2">Nudge (px)</td>
                                    <td class="border-0 py-2"><input type="number" id="set_nudgeStep" class="input input-bordered w-full" value="${this._settings.nudgeStep}"></td>
                                </tr>
                                <tr class="border-0 py-2">
                                    <td class="border-0 py-2">Shift Nudge</td>
                                    <td class="border-0 py-2"><input type="number" id="set_nudgeShiftStep" class="input input-bordered w-full" value="${this._settings.nudgeShiftStep}"></td>
                                </tr>
                                <tr class="border-0 py-2">
                                    <td class="border-0 py-2">Auto-Scroll</td>
                                    <td class="border-0 py-2"><input type="checkbox" id="set_autoScroll" class="toggle toggle-primary" ${this._settings.autoScroll ? "checked" : ""}></td>
                                </tr>
                                <tr class="border-0 py-2">
                                    <td class="border-0 py-2">Auto-Save Interval</td>
                                    <td class="border-0 py-2">
                                        <select id="set_autoSaveInterval" class="select select-bordered w-full">
                                            <option value="0" ${this._settings.autoSaveInterval === 0 ? "selected" : ""}>Disabled</option>
                                            <option value="5000" ${this._settings.autoSaveInterval === 5000 ? "selected" : ""}>5 Seconds</option>
                                            <option value="10000" ${this._settings.autoSaveInterval === 10000 ? "selected" : ""}>10 Seconds (Standard)</option>
                                            <option value="30000" ${this._settings.autoSaveInterval === 30000 ? "selected" : ""}>30 Seconds</option>
                                            <option value="60000" ${this._settings.autoSaveInterval === 60000 ? "selected" : ""}>1 Minute</option>
                                        </select>
                                    </td>
                                </tr>
                                <tr class="border-0 py-2">
                                    <td class="border-0 py-2">Initial Zoom (%)</td>
                                    <td class="border-0 py-2"><input type="number" id="set_initialZoom" class="input input-bordered w-full" value="${this._settings.initialZoom}"></td>
                                </tr>
                            </tbody>
                        </table>
                    </div>

                    <div class="modal-action mt-10">
                        <form method="dialog" class="flex gap-4 w-full justify-end">
                            <button class="btn btn-ghost" style="width: 200px;">Cancel</button>
                            <button id="btnApplySettings" type="button" class="btn btn-primary shadow-lg shadow-primary/20" style="width: 200px;">Apply Settings</button>
                        </form>
                    </div>
                </div>
                <form method="dialog" class="modal-backdrop">
                    <button>close</button>
                </form>
            </dialog>

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
                <button class="btn btn-ghost btn-sm btn-circle tooltip tooltip-primary tooltip-top" data-tip="Select All Inside" data-action="select-all-inside">
                    <i class="ri-checkbox-multiple-line pointer-events-none"></i>
                </button>
                <button class="btn btn-ghost btn-sm btn-circle tooltip tooltip-primary tooltip-top" data-tip="Bring to Front" data-action="bring-to-front">
                    <i class="ri-bring-to-front pointer-events-none"></i>
                </button>
                <button class="btn btn-ghost btn-sm btn-circle tooltip tooltip-primary tooltip-top" data-tip="Send to Back" data-action="send-to-back">
                    <i class="ri-send-to-back pointer-events-none"></i>
                </button>
            </div>
        `;

    // Helper to close file dropdown
    const closeFileDropdown = () => {
      const dropdown = this.querySelector("#fileDropdown");
      if (!dropdown) return;

      // Support both focus-based and class-based dropdown opening modes.
      dropdown.classList.remove("dropdown-open");

      const activeEl = document.activeElement;
      if (activeEl && dropdown.contains(activeEl) && typeof activeEl.blur === "function") {
        activeEl.blur();
      }

      const dropdownLabel = dropdown.querySelector('label[tabindex="0"]');
      if (dropdownLabel) dropdownLabel.blur();

      const dropdownMenu = dropdown.querySelector("#fileDropdownMenu");
      if (dropdownMenu && typeof dropdownMenu.blur === "function") {
        dropdownMenu.blur();
      }
    };

    // Safety net: close menu for any File action click.
    const fileDropdownMenu = this.querySelector("#fileDropdownMenu");
    if (fileDropdownMenu) {
      fileDropdownMenu.addEventListener("click", (e) => {
        if (e.target.closest("a")) {
          closeFileDropdown();
        }
      });
    }

    // Toolbar Handlers
    this.querySelector("#btnSettings").onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeFileDropdown();
      this._showSettings();
    };
    this.querySelector("#btnTheme").onclick = () => this.toggleTheme();
    this.querySelector("#btnRefresh").onclick = () => {
      console.log("Refresh UI button clicked");
      const btn = this.querySelector("#btnRefresh");
      const icon = btn.querySelector("i");
      if (icon) icon.classList.add("animate-spin");
      this.refresh();
      setTimeout(() => {
        if (icon) icon.classList.remove("animate-spin");
      }, 500);
    };
    this.querySelector("#btnToggleJson").onclick = () => this.toggleJsonView();

    this.querySelector("#btnImport").onclick = (e) => {
      e.preventDefault();
      closeFileDropdown();
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
        this._autoSave(); // Immediately save to localStorage
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
      closeFileDropdown();
      if (this._engine) {
        this._engine.download(this._currentFilename);
      }
      this.dispatchEvent(new CustomEvent("export-layout"));
    };


    // JSON Handlers
    this.querySelector("#btnExportJson").onclick = (e) => {
        e.preventDefault();
        closeFileDropdown();
        if (!this._engine) return;
        const layout = this._engine.getLayout();
        const blob = new Blob([JSON.stringify(layout, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = this._currentFilename.replace(/\.(bjl|bal)$/i, ".json");
        a.click();
        URL.revokeObjectURL(url);
        this.dispatchEvent(new CustomEvent("export-json"));
    };

    this.querySelector("#btnImportJson").onclick = (e) => {
        e.preventDefault();
        closeFileDropdown();
        this.querySelector("#fileImportJson").click();
    };

    // Save Handlers
    this.querySelector("#btnSave").onclick = (e) => {
        e.preventDefault();
        closeFileDropdown();
        this._autoSave();
        Swal.fire({
            icon: "success",
            title: "Saved!",
            text: "Layout saved to localStorage",
            toast: true,
            position: "top-end",
            showConfirmButton: false,
            timer: 2000
        });
    };

    this.querySelector("#btnSaveAs").onclick = async (e) => {
        e.preventDefault();
        closeFileDropdown();
        if (!this._engine) return;
        
        const { value: filename } = await Swal.fire({
            title: "Save As",
            input: "text",
            inputLabel: "Enter filename",
            inputValue: this._currentFilename,
            showCancelButton: true,
            inputValidator: (value) => {
                if (!value) {
                    return "Please enter a filename";
                }
                if (!/\.(bjl|bal)$/i.test(value)) {
                    return "Filename must end with .bjl or .bal";
                }
            }
        });
        
        if (filename) {
            this._currentFilename = filename;
            const titleEl = this.querySelector("#toolbarTitle");
            if (titleEl) titleEl.innerText = this._currentFilename;
            this._engine.download(filename);
            this._autoSave(); // Also save to localStorage with new name
            Swal.fire({
                icon: "success",
                title: "Exported!",
                text: `Saved as ${filename}`,
                toast: true,
                position: "top-end",
                showConfirmButton: false,
                timer: 2000
            });
        }
    };

    this.querySelector("#btnExit").onclick = async (e) => {
        e.preventDefault();
        closeFileDropdown();
        const result = await Swal.fire({
            title: "Exit Designer?",
            text: "This will clear the current layout. Make sure you have saved your work.",
            icon: "question",
            showCancelButton: true,
            confirmButtonText: "Yes, Exit",
            confirmButtonColor: "#d33"
        });

        if (result.isConfirmed) {
            // Hard reset without saveState/autoSave side effects.
            if (this._autoSaveTimer) {
                clearTimeout(this._autoSaveTimer);
                this._autoSaveTimer = null;
            }
            if (this._engine) {
                this._engine.layout = this._engine.newLayout();
                this._syncEngineVariantBoundsFromLayout();
            }
            this._selectedIds.clear();
            this._lastSelectedId = null;
            this._selectionAnchor = null;
            this._history = [];
            this._redoStack = [];
            this._currentFilename = "layout.bjl";
            const titleEl = this.querySelector("#toolbarTitle");
            if (titleEl) titleEl.innerText = this._currentFilename;
            try {
                sessionStorage.setItem("bjl_skip_restore_once", "1");
            } catch (e) {
                console.warn("Exit restore guard unavailable:", e);
            }
            localStorage.removeItem("bjl_draft");
            this._applyWorkspaceScalerSize();
            this.updateWorkspace();
            this._updateOutline();
            this._updateHistoryControls();
            this.dispatchEvent(new CustomEvent("exit-designer"));
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
                    this._syncEngineVariantBoundsFromLayout();
                    this._currentFilename = file.name.replace('.json', '.bjl');
                    const titleEl = this.querySelector("#toolbarTitle");
                    if (titleEl) titleEl.innerText = this._currentFilename;
                    this.refresh();
                    this._autoSave(); // Immediately save to localStorage
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
      this.setZoom(this._settings.initialZoom / 100);
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
      const selectTreeSubtree = (nodeId) => {
        const ids = this._getGeometrySubtreeIds(nodeId);
        this.selectElement(ids, { clearExisting: true });
        this._selectionAnchor = nodeId;
      };

      outlineTree.addEventListener("select", (e) =>
        this.selectElement(e.detail.id),
      );
      outlineTree.addEventListener("cut-node", (e) => {
        selectTreeSubtree(e.detail.id);
        this.cut();
      });
      outlineTree.addEventListener("copy-node", (e) => {
        selectTreeSubtree(e.detail.id);
        this.copy();
      });
      outlineTree.addEventListener("paste-node", (e) => {
        this.paste();
      });
      outlineTree.addEventListener("duplicate-node", (e) => {
        selectTreeSubtree(e.detail.id);
        this.duplicate();
      });
      outlineTree.addEventListener("bring-to-front-node", (e) => {
        selectTreeSubtree(e.detail.id);
        this.bringToFront();
      });
      outlineTree.addEventListener("send-to-back-node", (e) => {
        selectTreeSubtree(e.detail.id);
        this.sendToBack();
      });
      outlineTree.addEventListener("delete-node", (e) => {
        selectTreeSubtree(e.detail.id);
        this.deleteSelected();
      });
    }

    // Mark as initialized after first full render
    this._initialized = true;
  }

  updateWorkspace(selectionOnly = false, syncZOrder = false) {
    const workspace = this.querySelector("#workspace");
    if (!workspace || !this._engine) return;

    this._updateNudgeControls();
    this._updateClipboardControls();

    const layout = this._engine.getLayout();
    if (!layout || !layout.Data[":kids"]) return;

    // 0. Update Grid Visibility
    if (this._settings.showGrid) {
      workspace.classList.add("grid-dots");
    } else {
      workspace.classList.remove("grid-dots");
    }

    // 1. Delta Selection Update (High Performance Path)
    if (selectionOnly && !syncZOrder) {
      const idsToUpdate = new Set();
      // Reconcile current selection with any previously highlighted nodes.
      // This ensures clearSelection() (e.g. via ESC) reliably removes stale UI state.
      this._selectedIds.forEach((id) => idsToUpdate.add(id));
      workspace
        .querySelectorAll(".designer-item.selected, .designer-item.tooltip-open")
        .forEach((item) => idsToUpdate.add(item.dataset.id));

      idsToUpdate.forEach((id) => {
        const item = workspace.querySelector(`.designer-item[data-id="${id}"]`);
        if (item) {
          const isSelected = this._selectedIds.has(id);
          item.classList.toggle("selected", isSelected);

          const tooltipClasses = [
            "tooltip",
            "tooltip-primary",
            "tooltip-right",
            "tooltip-open",
          ];
          if (isSelected && this._settings.showTooltips) {
            item.classList.add(...tooltipClasses);
          } else {
            item.classList.remove(...tooltipClasses);
          }
        }
      });
      return;
    }

    // 2. Targeted Z-Order Sync (High Performance Path)
    if (syncZOrder === "front" || syncZOrder === "back") {
      // Move all selected elements together
      const selectedItems = Array.from(this._selectedIds).map(id => 
        workspace.querySelector(`.designer-item[data-id="${id}"]`)
      ).filter(item => item);
      
      if (selectedItems.length > 0) {
        if (syncZOrder === "front") {
          // Append all selected items to the end
          selectedItems.forEach(item => workspace.appendChild(item));
        } else {
          // Prepend all selected items to the beginning
          selectedItems.forEach(item => workspace.prepend(item));
        }
      }
      return; // Exit early for targeted moves
    }

    // 3. Structural Update Logic
    const resolvedState = this._getResolvedLayoutState();
    const allViews = resolvedState.records.map((record) => record.view);
    const resolvedById = resolvedState.map;

    const existingItems = workspace.querySelectorAll(".designer-item");

    // If count changed (add/delete/import), do a full re-render
    if (existingItems.length !== allViews.length) {
      workspace.innerHTML = this.renderElements();
      this.bindElementEvents();
      return;
    }

    // 4. Smart Update: Use item map to avoid N queries inside loop
    const itemMap = new Map();
    existingItems.forEach((item) => {
      itemMap.set(item.getAttribute("data-id"), item);
    });

    allViews.forEach((view) => {
      const item = itemMap.get(view.name);
      if (item) {
        // Physically reorder in DOM only if explicitly requested
        if (syncZOrder === true) {
          workspace.appendChild(item);
        }

        const isSelected = this._selectedIds.has(view.name);
        item.classList.toggle("selected", isSelected);

        const tooltipClasses = [
          "tooltip",
          "tooltip-primary",
          "tooltip-right",
          "tooltip-open",
        ];
        if (isSelected && this._settings.showTooltips) {
          item.classList.add(...tooltipClasses);
        } else {
          item.classList.remove(...tooltipClasses);
        }

        const resolved = resolvedById.get(view.name);
        const left = resolved ? resolved.left : Number(view.variant0.left) || 0;
        const top = resolved ? resolved.top : Number(view.variant0.top) || 0;
        const width = resolved
          ? resolved.width
          : Number(view.variant0.width) || 0;
        const height = resolved
          ? resolved.height
          : Number(view.variant0.height) || 0;
        const scaledLeft = left * this._scale;
        const scaledTop = top * this._scale;
        const scaledWidth = width * this._scale;
        const scaledHeight = height * this._scale;

        item.style.left = `${scaledLeft}px`;
        item.style.top = `${scaledTop}px`;
        item.style.width = `${scaledWidth}px`;
        item.style.height = `${scaledHeight}px`;

        this._updateTooltip(item, view, resolved || null);

        // Update Label Visibility and Content
        let label = item.querySelector(".item-label");
        if (this._settings.showLabels) {
          if (!label) {
            label = document.createElement("span");
            label.className = "item-label";
            item.prepend(label);
          }
          label.textContent = view.name;
          // Check rotation
          label.classList.remove("rotated");
          if (label.offsetWidth > item.offsetWidth - 5) {
            label.classList.add("rotated");
          }
        } else if (label) {
          label.remove();
        }
      }
    });
  }

  _updateNudgeControls() {
    // Enable nudge buttons when ANY items are selected (single or multi)
    const isTargetSelected = this._selectedIds.size > 0;
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
    if (!this._engine || !this._engine.getLayout()) return "";

    const resolvedState = this._getResolvedLayoutState();
    return resolvedState.records
      .map((record) => {
        const view = record.view;
        const isSelected = this._selectedIds.has(view.name);
        const hexColor = this._getColor(view.name);
        // Scale resolved positions and sizes with the workspace
        const scaledLeft = record.left * this._scale;
        const scaledTop = record.top * this._scale;
        const scaledWidth = record.width * this._scale;
        const scaledHeight = record.height * this._scale;

        const tooltipTip = "Name: " + view.name + 
                          "\nTop: " + record.top + 
                          "\nLeft: " + record.left + 
                          "\nWidth: " + record.width + 
                          "\nHeight: " + record.height;

        const tooltipClasses = isSelected && this._settings.showTooltips
          ? "tooltip tooltip-primary tooltip-right tooltip-open"
          : "";

        const labelHtml = this._settings.showLabels 
          ? '<span class="item-label">' + view.name + '</span>'
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
                    ${labelHtml}
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
