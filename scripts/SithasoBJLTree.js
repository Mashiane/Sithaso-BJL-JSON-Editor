class SithasoBJLTree extends HTMLElement {
    constructor() {
        super();
        this._nodes = new Map(); // Flat map for quick lookup: ID -> { parentID, nodeID, nodeText, nodeColor, children: [] }
        this._rootNodes = [];
        this._selectedId = null;
        this._styleInjected = false;
        this._showCheckboxes = false;
    }

    static get observedAttributes() {
        return ['checkbox'];
    }

    attributeChangedCallback(name, oldValue, newValue) {
        if (name === 'checkbox') {
            this._showCheckboxes = newValue !== null && newValue !== 'false';
            // We don't re-render everything to maintain performance, 
            // but new nodes will respect this. For an existing tree, 
            // the user should call clear() or re-add nodes if they toggle this live.
        }
    }

    connectedCallback() {
        if (!this._styleInjected) {
            this._injectStyles();
            this._styleInjected = true;
        }
        if (!this.querySelector('.tree-container')) {
            this.innerHTML += '<div class="tree-container"><ul class="menu menu-sm w-full"></ul></div>';
        }
        this._setupEvents();
    }

    _injectStyles() {
        const style = document.createElement('style');
        style.textContent = `
            bjl-tree {
                display: flex;
                flex-direction: column;
                width: 100%;
                height: 100%;
                overflow: hidden;
            }
            .tree-container {
                flex: 1;
                overflow-y: auto;
                overflow-x: hidden;
                scrollbar-width: thin;
                scrollbar-color: color-mix(in oklch, var(--color-base-content), transparent 70%) transparent;
            }
            .tree-container::-webkit-scrollbar {
                width: 6px;
            }
            .tree-container::-webkit-scrollbar-thumb {
                background-color: color-mix(in oklch, var(--color-base-content), transparent 70%);
                border-radius: 10px;
            }
            .tree-container .menu {
                padding-left: 0;
                width: 100%;
            }
            .tree-container .menu li > details > summary::after {
                justify-self: start;
                margin-left: 0.5rem;
            }
            .node-content {
                display: flex;
                align-items: center;
                gap: 0.5rem;
                width: 100%;
            }
            .node-color {
                width: 10px;
                height: 10px;
                border-radius: 50%;
                flex-shrink: 0;
            }
            .node-text {
                flex: 1;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                font-size: 0.85rem;
            }
            .node-actions {
                opacity: 0;
                display: flex;
                align-items: center;
                transition: opacity 0.2s;
            }
            li:hover > a .node-actions,
            li:hover > details > summary .node-actions {
                opacity: 1;
            }
            .smart-action-menu {
                position: fixed;
                display: none;
                background: color-mix(in oklch, var(--color-base-100), transparent 30%);
                backdrop-filter: blur(12px);
                border: 1px solid color-mix(in oklch, var(--color-base-content), transparent 90%);
                border-radius: 9999px;
                padding: 4px;
                box-shadow: 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);
                z-index: 1000;
                animation: popIn 0.2s ease-out;
            }
            .smart-action-menu.active {
                display: flex;
                gap: 2px;
            }
            @keyframes popIn {
                from { opacity: 0; transform: scale(0.9) translateY(10px); }
                to { opacity: 1; transform: scale(1) translateY(0); }
            }
            .btn-node-trigger {
                width: 24px;
                height: 24px;
                min-height: 24px;
                padding: 0;
                border-radius: 9999px;
            }
            .selected > a, 
            .selected > details > summary {
                background-color: var(--color-primary) !important;
                color: var(--color-primary-content) !important;
            }
            .selected > a *, 
            .selected > details > summary * {
                color: var(--color-primary-content) !important;
            }
            .node-icon {
                font-size: 1.1rem;
                opacity: 0.7;
            }
            .menu li > details > ul {
                margin-left: 1rem;
                padding-left: 0;
                border-left: 1px solid color-mix(in oklch, var(--color-base-content), transparent 90%);
            }
        `;
        this.appendChild(style);
    }

    /**
     * Clears all nodes from the tree.
     */
    clear() {
        this._nodes.clear();
        this._rootNodes = [];
        this._selectedId = null;
        const rootList = this.querySelector('.menu');
        if (rootList) rootList.innerHTML = '';
    }

    /**
     * Adds a node to the tree.
     */
    addNode(parentID, nodeID, nodeText, nodeColor, icon = '') {
        if (this._nodes.has(nodeID)) {
            console.warn(`Node with ID "${nodeID}" already exists.`);
            return;
        }

        const node = { parentID, nodeID, nodeText, nodeColor, icon, children: [] };
        this._nodes.set(nodeID, node);

        let container;
        if (!parentID || parentID === "") {
            this._rootNodes.push(node);
            container = this.querySelector('.menu');
        } else {
            const parent = this._nodes.get(parentID);
            if (parent) {
                parent.children.push(node);
                container = this._ensureParentContainer(parentID);
            } else {
                console.error(`Parent ID "${parentID}" not found. Adding to root.`);
                this._rootNodes.push(node);
                container = this.querySelector('.menu');
            }
        }

        if (container) {
            const li = this._createNodeElement(node.nodeID, node.nodeText, node.nodeColor, node.icon);
            container.appendChild(li);
        }
    }

    _ensureParentContainer(parentID) {
        let parentLi = this.querySelector(`li[data-id="${parentID}"]`);
        if (!parentLi) return null;

        let details = parentLi.querySelector('details');
        if (!details) {
            // Convert simple LI to folder type
            const oldA = parentLi.querySelector('a');
            const content = oldA ? oldA.innerHTML : '';
            const oldMenu = parentLi.querySelector('.smart-action-menu');
            const menuHtml = oldMenu ? oldMenu.outerHTML : '';
            if (oldA) oldA.remove();

            parentLi.innerHTML = `
                <details open data-id="${parentID}">
                    <summary>${content}</summary>
                    <ul></ul>
                </details>
                ${menuHtml}
            `;
            details = parentLi.querySelector('details');
        }
        return details.querySelector('ul');
    }

    _createNodeElement(nodeID, nodeText, nodeColor, icon = '') {
        const li = document.createElement('li');
        li.dataset.id = nodeID;
        
        const isSelected = this._selectedId === nodeID;
        if (isSelected) li.classList.add('selected');

        const content = `
            <a class="flex items-center gap-2 py-1 px-2 hover:bg-base-200 transition-colors group relative">
                ${this._showCheckboxes ? '<input type="checkbox" class="checkbox checkbox-sm" />' : ''}
                ${icon ? `<i class="${icon} node-icon"></i>` : ''}
                <div class="node-color" style="background: ${nodeColor}"></div>
                <span class="truncate flex-1" style="color: ${nodeColor || 'inherit'}">${nodeText}</span>
                <div class="node-actions pointer-events-auto">
                    <button class="btn btn-ghost btn-xs btn-node-trigger" data-action="toggle-menu">
                        <i class="ri-more-2-fill pointer-events-none"></i>
                    </button>
                </div>
            </a>
            <div class="smart-action-menu" data-id="${nodeID}">
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
            </div>
        `;
        li.innerHTML = content;
        return li;
    }

    /**
     * Updates the enabled state of all paste buttons in the tree.
     */
    updatePasteState(enabled) {
        this.querySelectorAll('button[data-action="paste"]').forEach(btn => {
            btn.disabled = !enabled;
        });
    }

    /**
     * Removes a specific node.
     */
    removeNode(nodeID) {
        const el = this.querySelector(`li[data-id="${nodeID}"]`);
        if (el) el.remove();

        const node = this._nodes.get(nodeID);
        if (!node) return;

        // Cleanup Map and local arrays
        const toRemove = [nodeID];
        const traverse = (n) => {
            n.children.forEach(child => {
                toRemove.push(child.nodeID);
                traverse(child);
            });
        };
        traverse(node);
        toRemove.forEach(id => this._nodes.delete(id));

        if (!node.parentID) {
            this._rootNodes = this._rootNodes.filter(n => n.nodeID !== nodeID);
        } else {
            const parent = this._nodes.get(node.parentID);
            if (parent) parent.children = parent.children.filter(n => n.nodeID !== nodeID);
        }

        if (this._selectedId === nodeID) this._selectedId = null;
    }

    /**
     * Selects and highlights a node.
     */
    select(nodeID) {
        if (this._selectedId === nodeID) return;
        
        // Deselect current
        if (this._selectedId) {
            const prev = this.querySelector(`li[data-id="${this._selectedId}"]`);
            if (prev) prev.classList.remove('selected');
        }

        this._selectedId = nodeID;
        if (nodeID) {
            const current = this.querySelector(`li[data-id="${nodeID}"]`);
            if (current) {
                current.classList.add('selected');
                this._openParents(nodeID);
                current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }
        }
    }

    _openParents(nodeID) {
        let current = this._nodes.get(nodeID);
        while (current && current.parentID) {
            const parentEl = this.querySelector(`details[data-id="${current.parentID}"]`);
            if (parentEl) parentEl.open = true;
            current = this._nodes.get(current.parentID);
        }
    }

    getCheckedNodes() {
        return Array.from(this.querySelectorAll('input[type="checkbox"]:checked'))
            .map(cb => cb.closest('[data-id]').dataset.id);
    }

    /**
     * Returns an array of all node IDs currently in the tree.
     */
    getExistingIds() {
        return Array.from(this._nodes.keys());
    }

    _setupEvents() {
        const resolveNodeId = (target) => {
            const holder = target.closest('li[data-id], details[data-id]');
            return holder ? holder.dataset.id : null;
        };

        // Listen for clicks on nodes
        this.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-action]');
            const id = resolveNodeId(e.target);
            if (!id) return;

            if (btn) {
                e.preventDefault();
                e.stopPropagation();
                const action = btn.dataset.action;

                if (action === 'toggle-menu') {
                    this._toggleSmartMenu(id, btn);
                    return;
                }

                this._closeAllMenus();
                this.dispatchEvent(new CustomEvent(`${action}-node`, { detail: { id } }));
                return;
            }

            if (!e.target.classList.contains('checkbox')) {
                e.stopPropagation(); // Standardize event handling
                this._closeAllMenus();
                this.select(id);
                this.dispatchEvent(new CustomEvent('select', { detail: { id } }));
            }
        });

        // Right-click anywhere on a node should open the same smart menu.
        this.addEventListener('contextmenu', (e) => {
            if (e.target.closest('.smart-action-menu')) return;
            const id = resolveNodeId(e.target);
            if (!id) return;

            e.preventDefault();
            e.stopPropagation();

            this.select(id);
            this.dispatchEvent(new CustomEvent('select', { detail: { id } }));
            this._toggleSmartMenu(id, null, { x: e.clientX, y: e.clientY }, true);
        });

        // Close menus on outside click or scroll
        window.addEventListener('mousedown', (e) => {
            if (!e.target.closest('.smart-action-menu') && !e.target.closest('.btn-node-trigger')) {
                this._closeAllMenus();
            }
        });

        this.addEventListener('scroll', () => this._closeAllMenus(), true);
    }

    _toggleSmartMenu(id, trigger = null, position = null, forceOpen = false) {
        const menu = this.querySelector(`.smart-action-menu[data-id="${id}"]`);
        if (!menu) return;

        const alreadyActive = menu.classList.contains('active');
        this._closeAllMenus();

        if (alreadyActive && !forceOpen) return;

        let left = 0;
        let top = 0;
        if (position) {
            left = position.x;
            top = position.y;
        } else if (trigger) {
            const rect = trigger.getBoundingClientRect();
            left = rect.right - 210;
            top = rect.top - 50;
        }

        menu.classList.add('active');

        // Keep menu inside viewport.
        const pad = 8;
        const menuRect = menu.getBoundingClientRect();
        const maxLeft = Math.max(pad, window.innerWidth - menuRect.width - pad);
        const maxTop = Math.max(pad, window.innerHeight - menuRect.height - pad);
        menu.style.left = `${Math.min(Math.max(left, pad), maxLeft)}px`;
        menu.style.top = `${Math.min(Math.max(top, pad), maxTop)}px`;
    }

    _closeAllMenus() {
        this.querySelectorAll('.smart-action-menu.active').forEach(m => {
            m.classList.remove('active');
        });
    }
}

customElements.define('bjl-tree', SithasoBJLTree);
