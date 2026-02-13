/* ============================================================
   SithasoLayoutEngine & BJLConverter Consolidated Library
   Fully Browser-Compatible (Pure JS + pako dependency)
   ============================================================ */

/* ---------- Utilities ---------- */

function toUint8(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer);
}

function concatBytes(...arrays) {
  const len = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

/* ---------- Binary Reader ---------- */

class BinaryReader {
  constructor(bytes) {
    this.buffer = toUint8(bytes);
    this.view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
    this.offset = 0;
  }
  readByte() { return this.view.getUint8(this.offset++); }
  readSignedByte() { return this.view.getInt8(this.offset++); }
  readInt() {
    const v = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return v;
  }
  readFloat() {
    const v = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return v;
  }
  readBytes(len) {
    const b = this.buffer.slice(this.offset, this.offset + len);
    this.offset += len;
    return b;
  }
}

/* ---------- Binary Writer ---------- */

class BinaryWriter {
  constructor(size = 1024 * 1024) {
    this.buffer = new Uint8Array(size);
    this.view = new DataView(this.buffer.buffer);
    this.offset = 0;
  }
  ensure(len) {
    if (this.offset + len <= this.buffer.length) return;
    const n = new Uint8Array((this.buffer.length + len) * 2);
    n.set(this.buffer);
    this.buffer = n;
    this.view = new DataView(n.buffer);
  }
  writeByte(v) { this.ensure(1); this.view.setUint8(this.offset++, v & 0xff); }
  writeInt(v) {
    this.ensure(4);
    this.view.setInt32(this.offset, v | 0, true);
    this.offset += 4;
  }
  writeFloat(v) {
    this.ensure(4);
    this.view.setFloat32(this.offset, v, true);
    this.offset += 4;
  }
  writeBytes(bytes) {
    bytes = toUint8(bytes);
    this.ensure(bytes.length);
    this.buffer.set(bytes, this.offset);
    this.offset += bytes.length;
  }
  updateInt(offset, v) { this.view.setInt32(offset, v | 0, true); }
  getBuffer() { return this.buffer.slice(0, this.offset); }
}

/* ---------- TYPE CODES ---------- */

const TYPE_CODES = {
  CINT: 1, CSTRING: 2, CMAP: 3, ENDOFMAP: 4, BOOL: 5,
  CCOLOR: 6, CFLOAT: 7, CACHED_STRING: 9, RECT32: 11, CNULL: 12,
};

/* ---------- Compression ---------- */

class CompressedStreams {
  CompressBytes(bytes) {
    return pako.gzip(bytes, { level: 1, mtime: 0, header: { os: 0 } });
  }
  DecompressBytes(bytes) {
    return pako.ungzip(bytes);
  }
}

/* ---------- BJLConverter ---------- */

class BJLConverter {
  constructor(toBil = false) {
    this.toBil = toBil;
    this.compressor = new CompressedStreams();
  }

  async convertBjlToJsonFromFile(file) {
    if (!file || typeof file.arrayBuffer !== 'function') {
      throw new TypeError('convertBjlToJsonFromFile expects a File/Blob with arrayBuffer()');
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    return this.convertBjlToJsonFromBytes(bytes);
  }

  async convertBjlToJsonFromURL(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch BJL from ${url}: ${response.statusText}`);
    const buffer = await response.arrayBuffer();
    return this.convertBjlToJsonFromBytes(new Uint8Array(buffer));
  }

  async convertBjlToJsonFromBytes(bytes) {
    const reader = new BinaryReader(bytes);
    const header = this._readLayoutHeader(reader);
    if (header.Version < 3) throw new Error("Unsupported BJL version");

    const design = {
      LayoutHeader: header, Variants: [], Data: {}, FontAwesome: false, MaterialIcons: false,
    };

    const cache = this._loadStringsCache(reader);
    const variantCount = reader.readInt();
    for (let i = 0; i < variantCount; i++) {
      design.Variants.push({
        Scale: reader.readFloat(), Width: reader.readInt(), Height: reader.readInt(),
      });
    }

    design.Data = this._readMap(reader, cache);
    reader.readInt(); // footer padding
    design.FontAwesome = reader.readSignedByte() === 1;
    design.MaterialIcons = reader.readSignedByte() === 1;
    return design;
  }

  async convertJsonToBjlToBytes(json) {
    const writer = new BinaryWriter();
    const variants = json.Variants || [];
    this._writeLayoutHeader(json.LayoutHeader || {}, writer, variants);
    this._writeAllLayout(writer, variants, json.Data || {}, json.LayoutHeader || {});
    writer.writeByte(json.FontAwesome ? 1 : 0);
    writer.writeByte(json.MaterialIcons ? 1 : 0);
    return writer.getBuffer();
  }

  _readMap(reader, cache) {
    const map = {};
    while (true) {
      const key = this._readCachedString(reader, cache);
      const type = reader.readSignedByte();
      if (type === TYPE_CODES.ENDOFMAP) break;

      let value;
      switch (type) {
        case TYPE_CODES.CINT: value = reader.readInt(); break;
        case TYPE_CODES.CACHED_STRING: value = this._readCachedString(reader, cache); break;
        case TYPE_CODES.CFLOAT: value = { ValueType: type, Value: reader.readFloat() }; break;
        case TYPE_CODES.CSTRING: value = { ValueType: type, Value: this._readString(reader) }; break;
        case TYPE_CODES.BOOL: value = reader.readSignedByte() === 1; break;
        case TYPE_CODES.CMAP: value = this._readMap(reader, cache); break;
        case TYPE_CODES.CNULL: value = { ValueType: type }; break;
        case TYPE_CODES.CCOLOR: {
          const d = reader.readBytes(4);
          value = { ValueType: type, Value: '0x' + this._hexFromBytes(d) };
          break;
        }
        case TYPE_CODES.RECT32: {
          const d = reader.readBytes(8);
          const shorts = [];
          const v = new DataView(d.buffer);
          for (let i = 0; i < 8; i += 2) shorts.push(v.getInt16(i, true));
          value = { ValueType: type, Value: shorts };
          break;
        }
        default: return map;
      }
      map[key] = value;
    }
    return map;
  }

  _readLayoutHeader(reader) {
    const h = { Version: 0, GridSize: 10, ControlsHeaders: [], Files: [], DesignerScript: [] };
    const version = reader.readInt();
    h.Version = version;
    if (version < 3) return h;
    reader.offset += 4;
    if (version >= 4) h.GridSize = reader.readInt();

    const cache = this._loadStringsCache(reader);
    const cCount = reader.readInt();
    for (let i = 0; i < cCount; i++) {
        h.ControlsHeaders.push({
            Name: this._readCachedString(reader, cache),
            JavaType: this._readCachedString(reader, cache),
            DesignerType: this._readCachedString(reader, cache),
        });
    }

    const fCount = reader.readInt();
    for (let i = 0; i < fCount; i++) h.Files.push(this._readString(reader));
    h.DesignerScript = this._readScripts(reader);
    return h;
  }

  _readScripts(reader) {
    const len = reader.readInt();
    const rawData = reader.readBytes(len);
    try {
      const decompressed = pako.ungzip(rawData);
      const script = new BinaryReader(decompressed);
      const res = [];
      res.push(this._readBinaryString(script));
      const NumberOfVariants = script.readInt();
      for (let i = 0; i < NumberOfVariants; i++) {
        this._readVariantFromStream(script);
        res.push(this._readBinaryString(script));
      }
      return res;
    } catch (_e) { return []; }
  }

  _readBinaryString(reader) {
    let length = 0, shift = 0;
    while (true) {
      const b = reader.readSignedByte();
      const value = b & 0x7f;
      length += value << shift;
      if (b === value) break;
      shift += 7;
    }
    const data = reader.readBytes(length);
    return new TextDecoder().decode(data);
  }

  _writeScripts(scripts, variants) {
    const writer = new BinaryWriter();
    let scriptIdx = 0;
    const scriptsCopy = [...scripts];
    this._writeBinaryString(writer, scriptsCopy[scriptIdx++] || "");
    writer.writeInt(variants.length);
    for (const v of variants) {
      writer.writeFloat(v.Scale || 1);
      writer.writeInt(v.Width || 0);
      writer.writeInt(v.Height || 0);
      this._writeBinaryString(writer, scriptsCopy[scriptIdx++] || "");
    }
    const uncompressed = writer.getBuffer();
    return pako.gzip(uncompressed, { level: 1, mtime: 0, header: { os: 0 } });
  }

  _writeBinaryString(writer, s) {
    const text = String(s ?? "");
    const raw = new TextEncoder().encode(text);
    let len = text.length;
    while (true) {
      let b = len & 0x7f;
      len >>>= 7;
      if (len !== 0) b |= 0x80;
      writer.writeByte(b);
      if (len === 0) break;
    }
    writer.writeBytes(raw);
  }

  _readVariantFromStream(reader) {
    return { Scale: reader.readFloat(), Width: reader.readInt(), Height: reader.readInt() };
  }

  _writeVariant(writer, v) {
    writer.writeFloat(v.Scale || 1);
    writer.writeInt(v.Width || 0);
    writer.writeInt(v.Height || 0);
  }

  _loadStringsCache(reader) {
    const count = reader.readInt();
    const arr = new Array(count);
    for (let i = 0; i < count; i++) arr[i] = this._readString(reader);
    return arr;
  }

  _readCachedString(reader, cache) {
    if (!cache || cache.length === 0) return this._readString(reader);
    return cache[reader.readInt()];
  }

  _readString(reader) {
    const len = reader.readInt();
    return new TextDecoder().decode(reader.readBytes(len));
  }

  _writeString(writer, s) {
    const b = new TextEncoder().encode(s);
    writer.writeInt(b.length);
    writer.writeBytes(b);
  }

  _writeStringsCacheInOrder(writer, _cache, order) {
    writer.writeInt(order.length);
    for (const str of order) this._writeString(writer, str);
  }

  _writeTempToMain(tempWriter, mainWriter) { mainWriter.writeBytes(tempWriter.getBuffer()); }

  _writeCachedString(writer, cache, s) {
    if (!cache || Object.keys(cache).length === 0) {
      this._writeString(writer, s);
    } else {
      if (Object.prototype.hasOwnProperty.call(cache, s)) {
        writer.writeInt(cache[s]);
      } else {
        throw new Error(`String not in cache: "${s}"`);
      }
    }
  }

  _hexFromBytes(data) {
    return Array.from(toUint8(data)).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  }

  _hexToBytes(hex) {
    const clean = String(hex || '').replace(/[^0-9a-fA-F]/g, '');
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < clean.length; i += 2) out[i / 2] = parseInt(clean.substring(i, i + 2), 16);
    return out;
  }

  _shortsToBytes(shorts) {
    const out = new Uint8Array(shorts.length * 2);
    const v = new DataView(out.buffer);
    for (let i = 0; i < shorts.length; i++) v.setInt16(i * 2, shorts[i], true);
    return out;
  }

  _writeLayoutHeader(header, writer, variants) {
    const version = header?.Version || 4;
    writer.writeInt(version);
    const headerSizePosition = writer.offset;
    writer.writeInt(0);
    if (version >= 4) writer.writeInt(header?.GridSize || 10);

    const cache = {};
    const controlsHeaders = header?.ControlsHeaders || [];
    for (const c of controlsHeaders) {
      if (!(c.Name in cache)) cache[c.Name] = Object.keys(cache).length;
      if (!(c.JavaType in cache)) cache[c.JavaType] = Object.keys(cache).length;
      if (!(c.DesignerType in cache)) cache[c.DesignerType] = Object.keys(cache).length;
    }

    const tempWriter = new BinaryWriter();
    tempWriter.writeInt(controlsHeaders.length);
    for (const c of controlsHeaders) {
      this._writeCachedString(tempWriter, cache, c.Name);
      this._writeCachedString(tempWriter, cache, c.JavaType);
      this._writeCachedString(tempWriter, cache, c.DesignerType);
    }

    const cacheKeys = Object.keys(cache);
    writer.writeInt(cacheKeys.length);
    for (const k of cacheKeys) this._writeString(writer, k);
    writer.writeBytes(tempWriter.getBuffer());

    const files = header?.Files || [];
    writer.writeInt(files.length);
    for (const f of files) this._writeString(writer, f);

    let scriptBytes = new Uint8Array(0);
    if (Array.isArray(header?.DesignerScript)) {
      scriptBytes = toUint8(this._writeScripts(header.DesignerScript, variants || []));
    }
    writer.writeInt(scriptBytes.length);
    writer.writeBytes(scriptBytes);

    const finalPosition = writer.offset;
    writer.updateInt(headerSizePosition, finalPosition - headerSizePosition - 4);
  }

  _writeAllLayout(writer, variants, data, _layoutHeader) {
    let cache = {}, order = [];
    this._collectStringsInOrder(data, cache, order);
    const tempWriter = new BinaryWriter();
    tempWriter.writeInt(variants.length);
    for (const v of variants) this._writeVariant(tempWriter, v);
    this._writeMap(tempWriter, data, cache);
    this._writeString(tempWriter, '');
    tempWriter.writeByte(TYPE_CODES.ENDOFMAP);
    this._writeStringsCacheInOrder(writer, cache, order);
    this._writeTempToMain(tempWriter, writer);
    writer.writeInt(0);
  }

  _collectStringsInOrder(data, cache, order) {
    if (!data || typeof data !== 'object') return;
    if (Array.isArray(data)) {
      for (const item of data) this._collectStringsInOrder(item, cache, order);
    } else {
      for (const key of Object.keys(data)) {
        if (!(key in cache)) { cache[key] = Object.keys(cache).length; order.push(key); }
        const val = data[key];
        if (typeof val === 'object' && val !== null) {
          if (val.ValueType === undefined) this._collectStringsInOrder(val, cache, order);
          else if (val.ValueType === TYPE_CODES.CSTRING && typeof val.Value === 'string') {
            if (!(val.Value in cache)) { cache[val.Value] = Object.keys(cache).length; order.push(val.Value); }
          }
        } else if (typeof val === 'string') {
          if (!(val in cache)) { cache[val] = Object.keys(cache).length; order.push(val); }
        }
      }
    }
  }

  _writeMap(writer, m, cache) {
    for (const k of Object.keys(m)) {
      const val = m[k];
      this._writeCachedString(writer, cache, k);
      if (typeof val === 'object' && val !== null) {
        if (val.ValueType !== undefined) {
          writer.writeByte(val.ValueType);
          switch (val.ValueType) {
            case TYPE_CODES.CSTRING: this._writeString(writer, val.Value); break;
            case TYPE_CODES.CFLOAT: writer.writeFloat(val.Value); break;
            case TYPE_CODES.CCOLOR: writer.writeBytes(this._hexToBytes(String(val.Value).substring(2))); break;
            case TYPE_CODES.RECT32: writer.writeBytes(this._shortsToBytes(val.Value)); break;
            case TYPE_CODES.CNULL: break;
          }
        } else {
          writer.writeByte(TYPE_CODES.CMAP);
          this._writeMap(writer, val, cache);
          this._writeString(writer, '');
          writer.writeByte(TYPE_CODES.ENDOFMAP);
        }
      } else if (typeof val === 'number' && Number.isInteger(val)) {
        writer.writeByte(TYPE_CODES.CINT); writer.writeInt(val);
      } else if (typeof val === 'string') {
        writer.writeByte(TYPE_CODES.CACHED_STRING); this._writeCachedString(writer, cache, val);
      } else if (typeof val === 'boolean') {
        writer.writeByte(TYPE_CODES.BOOL); writer.writeByte(val ? 1 : 0);
      } else if (val === null) writer.writeByte(TYPE_CODES.CNULL);
    }
  }
}

/* ---------- SithasoLayoutEngine ---------- */

const BASE_LAYOUT_B64 = "H4sIAAAAAAACA5VTbWvbMBD+K+EY9IsT3MG6YdiHktRLtqWMpKQftny4yJdYqyoZSc5Lg//7TrbSdoV1m8H4Xh7dPff4dISveDC1HxMWZCE7woKsk0ZD9i6BT1YWc/lAkJ2nCQyN9tYo12EdZN+PcI33nIUpSg0JfMYt3hyqEBl8Q023FquK7Bs+KSx5ehZj9Iic3Giy8URIQrNMIJeKQvXlE2QurKw8x+DsUqneFq1E7V3PtfEfoffZogv2XEVCrqWIyax3kaZ7fhMnUNHHc0YvmwQivBtjHlI8ZQK3svAlZAEPY5Kb0rdO4DVCj0Eh4SLj0QqdFIMTycGUPEYl/D+rgKoq27ILVDV1ld8nnceMmOnKWNZ7aJSxL3AXjzhI93metg88Homz/KF0yjhhLBOfYSFr9yqwsLjDVdDolflHETRouZ68JzVehsXfR8rT/EOeQxPBX+jAif5631+huNtYU+ui35UJJGuLvt1d/nmkQ5cCMm9rYndL2j/b1tzYe6ZAe29x6Hh4YG8tw4TBKlEXimY82QNdhaOnOj//a8X1b9fDWMmVIkWYXI+vZpMbjldo2w6hscdNNKRvyUSiW+lkq39HI96ANKinaO3bkb2p2u+u++9vww6XcYc7B7Uog+RpqHCyWbnsThZhARq2c77mlztyJlBfo3LcboqeuKGaCKNdjDa/AHkjiXk8BAAA";

class SithasoLayoutEngine {
    constructor(bjlJson = null, options = {}) {
        this.margin = options.margin !== undefined ? options.margin : 10;
        this.innerMargin = options.innerMargin !== undefined ? options.innerMargin : 5;
        this.defaultWidth = options.defaultWidth || 100;
        this.defaultHeight = options.defaultHeight || 60;
        this.variantWidth = Number(options.variantWidth) > 0 ? Number(options.variantWidth) : 600;
        this.variantHeight = Number(options.variantHeight) > 0 ? Number(options.variantHeight) : 600;
        this.TYPE_CODES = TYPE_CODES;
        this.layout = bjlJson || this.newLayout();
        if (bjlJson) {
            this.syncVariantBoundsFromLayout(bjlJson);
        }
        this.schemas = {};
    }

    /**
     * Instantiates an engine from a remote BJL file.
     */
    static async fromURL(url) {
        const engine = new SithasoLayoutEngine();
        await engine.loadURL(url);
        return engine;
    }

    /**
     * Instantiates an engine from a local BJL File/Blob object.
     */
    static async fromFile(file) {
        const engine = new SithasoLayoutEngine();
        await engine.loadFile(file);
        return engine;
    }

    /**
     * Loads a remote BJL file into this instance.
     */
    async loadURL(url) {
        const converter = new BJLConverter();
        this.layout = await converter.convertBjlToJsonFromURL(url);
        this.syncVariantBoundsFromLayout();
        return this.layout;
    }

    /**
     * Loads a local BJL File/Blob object into this instance.
     */
    async loadFile(file) {
        const converter = new BJLConverter();
        this.layout = await converter.convertBjlToJsonFromFile(file);
        this.syncVariantBoundsFromLayout();
        return this.layout;
    }

    syncVariantBoundsFromLayout(layout = this.layout) {
        const variants = layout && Array.isArray(layout.Variants) ? layout.Variants : [];
        const variant0 = variants[0] || null;
        const width = Number(variant0 && variant0.Width);
        const height = Number(variant0 && variant0.Height);

        if (Number.isFinite(width) && width > 0) this.variantWidth = width;
        if (Number.isFinite(height) && height > 0) this.variantHeight = height;

        return { width: this.variantWidth, height: this.variantHeight };
    }

    /**
     * Gets the current layout state.
     */
    getLayout() {
        return this.layout;
    }

    /**
     * Downloads the current layout as a .bjl file (Browser only).
     */
    async download(fileName = 'custom_layout.bjl') {
        if (typeof window === 'undefined' || typeof document === 'undefined') {
            throw new Error("download() is only supported in browser environments.");
        }
        const converter = new BJLConverter();
        const outputBytes = await converter.convertJsonToBjlToBytes(this.layout);

        const blob = new Blob([outputBytes], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.click();
        URL.revokeObjectURL(url);
    }

    /**
     * Creates a new layout base from the embedded gzipped template.
     */
    newLayout() {
        const compressed = this._decodeB64(BASE_LAYOUT_B64);
        const bytes = pako.ungzip(compressed);
        return JSON.parse(new TextDecoder().decode(bytes));
    }

    _decodeB64(b64) {
        if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
        const bin = atob(b64);
        const res = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) res[i] = bin.charCodeAt(i);
        return res;
    }

    async addSchema(url) {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Failed to fetch schema from ${url}: ${response.statusText}`);
        const schema = await response.json();
        const name = schema.name || url.split('/').pop().replace('.json', '');
        schema.name = name; // Ensure name is set
        this.schemas[name] = schema;
        return schema;
    }

    async addSchemas(urls = []) {
        return Promise.all(urls.map(url => this.addSchema(url)));
    }

    _createView(componentNameOrDef, name, parentName, overrides = {}) {
        let componentDef = componentNameOrDef;
        if (typeof componentNameOrDef === 'string') {
            componentDef = this.schemas[componentNameOrDef];
            if (!componentDef) throw new Error(`Schema not found: ${componentNameOrDef}. Call addSchema first.`);
        }

        const componentType = componentDef.name || componentDef.shortType || "";
        const props = {};

        // Load defaults from schema
        if (Array.isArray(componentDef.properties)) {
            componentDef.properties.forEach(p => {
                let val = p.DefaultValue || "";
                if (p.FieldType === "Boolean") val = String(val).toLowerCase() === "true";
                else if (p.FieldType === "Int") val = parseInt(val) || 0;
                else if (p.FieldType === "Float") val = parseFloat(val) || 0;
                props[p.Key] = val;
            });
        }
        
        // Merge flattened overrides
        Object.assign(props, overrides);

        return {
            csType: "Dbasic.Designer.MetaCustomView",
            type: ".CustomViewWrapper",
            alignment: "CENTER",
            alpha: { ValueType: this.TYPE_CODES.CFLOAT, Value: 1 },
            borderColor: { ValueType: this.TYPE_CODES.CCOLOR, Value: "0xFF000000" },
            borderWidth: { ValueType: this.TYPE_CODES.CFLOAT, Value: 1 },
            contextMenu: "",
            cornerRadius: { ValueType: this.TYPE_CODES.CFLOAT, Value: 3 },
            customProperties: {
                csType: "Dbasic.Designer.MetaCustomView+CustomDataGrid",
                type: "",
                ...props,
                customType: `b4j.example.${componentType.toLowerCase()}`,
                shortType: componentType
            },
            customType: `b4j.example.${componentType.toLowerCase()}`,
            drawable: {
                csType: "Dbasic.Designer.Drawable.ColorDrawable",
                type: "ColorDrawable",
                color: { ValueType: this.TYPE_CODES.CCOLOR, Value: "0xFFF0F8FF" },
                colorKey: "-fx-background-color"
            },
            enabled: true, eventName: name, extraCss: "",
            font: {
                csType: "Dbasic.Designer.FontGrid", type: "B4IFontWrapper", bold: false, fontName: "DEFAULT",
                fontSize: { ValueType: this.TYPE_CODES.CFLOAT, Value: 15 }, italic: false
            },
            fontAwesome: "", hanchor: 0, height: 100, javaType: ".CustomViewWrapper", left: 0,
            materialIcons: "", name: name, parent: "Main", // Physically children of Main
            shadow: {
                csType: "Dbasic.Designer.ShadowGrid", type: "", offsetX: { ValueType: this.TYPE_CODES.CFLOAT, Value: 0 },
                offsetY: { ValueType: this.TYPE_CODES.CFLOAT, Value: 0 }, radius: { ValueType: this.TYPE_CODES.CFLOAT, Value: 10 },
                shadowColor: { ValueType: this.TYPE_CODES.CCOLOR, Value: "0xFF000000" }, stype: 0
            },
            shortType: componentType, tag: "", text: "",
            textColor: { ValueType: this.TYPE_CODES.CCOLOR, Value: "0xFFF0F8FF" }, toolTip: "", top: 0, vanchor: 0,
            visible: true, width: 100, wrapText: false,
            variant0: {
                left: 0, top: 0, 
                width: Number(overrides.Width) || this.defaultWidth, 
                height: Number(overrides.Height) || this.defaultHeight, 
                hanchor: 0, vanchor: 0
            }
        };
    }

    _inject(parentName, view) {
        // ALWAYS inject into Main for physical flatness in BJL file
        const root = this.layout.Data;
        if (!root[':kids']) root[':kids'] = {};
        const index = Object.keys(root[':kids']).length;
        root[':kids'][String(index)] = view;
        
        // Ensure header exists
        if (view.type === ".CustomViewWrapper") {
            this._ensureHeader(view.name, view.shortType);
        }
        return view;
    }

    addComponent(componentNameOrDef, name, parentOrOverrides = "Main", overrides = {}) {
        let parentName = "Main";
        let finalOverrides = overrides;
        
        if (typeof parentOrOverrides === 'object') {
            finalOverrides = parentOrOverrides;
        } else {
            parentName = parentOrOverrides;
        }

        const view = this._createView(componentNameOrDef, name, parentName, finalOverrides);
        
        const allViews = Object.values(this.layout.Data[':kids'] || {});
        const parentComp = parentName !== "Main"
            ? this._findView(this.layout.Data, parentName)
            : null;

        const isStrictlyInside = (innerView, outerView) => {
            if (!innerView?.variant0 || !outerView?.variant0) return false;
            const inner = innerView.variant0;
            const outer = outerView.variant0;
            return (
                inner.left > outer.left &&
                inner.top > outer.top &&
                inner.left + inner.width < outer.left + outer.width &&
                inner.top + inner.height < outer.top + outer.height
            );
        };

        const getDirectChildren = (containerView) => {
            const inside = allViews.filter(v =>
                v.name !== containerView.name && isStrictlyInside(v, containerView)
            );
            return inside.filter(v =>
                !inside.some(other =>
                    other.name !== v.name && isStrictlyInside(v, other)
                )
            );
        };

        const siblings = parentName === "Main"
            ? allViews.filter(v =>
                !allViews.some(other =>
                    other.name !== v.name && isStrictlyInside(v, other)
                )
            )
            : (parentComp ? getDirectChildren(parentComp) : []);
        
        const m = parentName === "Main" ? this.margin : this.innerMargin;
        const w = view.variant0.width;

        if (siblings.length === 0) {
            if (parentName === "Main") {
                view.variant0.top = m;
                view.variant0.left = m;
            } else {
                // First nested child: Parent's absolute (left, top) + margin
                if (parentComp) {
                    view.variant0.top = parentComp.variant0.top + m;
                    view.variant0.left = parentComp.variant0.left + m;
                } else {
                    view.variant0.top = m;
                    view.variant0.left = m;
                }
            }
        } else {
            const last = siblings[siblings.length - 1];
            if (parentName === "Main") {
                // Horizontal wrapping logic on root
                let nextLeft = last.variant0.left + last.variant0.width + m;
                if (nextLeft + w + m > this.variantWidth) {
                    view.variant0.left = m;
                    let maxBottom = 0;
                    siblings.forEach(k => {
                        const b = k.variant0.top + k.variant0.height;
                        if (b > maxBottom) maxBottom = b;
                    });
                    view.variant0.top = maxBottom + m;
                } else {
                    view.variant0.left = nextLeft;
                    view.variant0.top = last.variant0.top;
                }
            } else {
                // Vertical stacking for logically nested items
                view.variant0.top = last.variant0.top + last.variant0.height + m;
                view.variant0.left = last.variant0.left; // Maintain same left as previous sibling
            }
        }
        
        const injected = this._inject(parentName, view);

        // Auto-expand parent container (if not Main)
        if (parentName !== "Main") {
            if (parentComp) {
                const right = view.variant0.left + view.variant0.width + this.innerMargin;
                const bottom = view.variant0.top + view.variant0.height + this.innerMargin;

                // Expand parent width if needed
                const currentParentRight = parentComp.variant0.left + parentComp.variant0.width;
                if (right > currentParentRight) {
                    const newWidth = Math.min(right - parentComp.variant0.left, this.variantWidth - parentComp.variant0.left);
                    parentComp.variant0.width = newWidth;
                    if (parentComp.customProperties) parentComp.customProperties.Width = newWidth;
                }

                // Expand parent height if needed
                const currentParentBottom = parentComp.variant0.top + parentComp.variant0.height;
                if (bottom > currentParentBottom) {
                    const newHeight = Math.min(bottom - parentComp.variant0.top, this.variantHeight - parentComp.variant0.top);
                    parentComp.variant0.height = newHeight;
                    if (parentComp.customProperties) parentComp.customProperties.Height = newHeight;
                }
            }
        }

        return injected;
    }

    addInside(componentNameOrDef, name, parentOrOverrides = "Main", overrides = {}) {
        return this.addComponent(componentNameOrDef, name, parentOrOverrides, overrides);
    }

    addBelow(componentDef, name, siblingName, overrides = {}) {
        const sibling = this._findView(this.layout.Data, siblingName);
        if (!sibling) throw new Error(`Sibling not found: ${siblingName}`);
        const view = this._createView(componentDef, name, sibling.parent, overrides);
        view.variant0.left = sibling.variant0.left;
        view.variant0.top = sibling.variant0.top + sibling.variant0.height + (overrides.Gap || this.margin);
        return this._inject(sibling.parent, view);
    }

    addRight(componentDef, name, siblingName, overrides = {}) {
        const sibling = this._findView(this.layout.Data, siblingName);
        if (!sibling) throw new Error(`Sibling not found: ${siblingName}`);
        const view = this._createView(componentDef, name, sibling.parent, overrides);
        view.variant0.top = sibling.variant0.top;
        view.variant0.left = sibling.variant0.left + sibling.variant0.width + (overrides.Gap || this.margin);
        return this._inject(sibling.parent, view);
    }

    addAbove(componentDef, name, siblingName, overrides = {}) {
        const sibling = this._findView(this.layout.Data, siblingName);
        if (!sibling) throw new Error(`Sibling not found: ${siblingName}`);
        const view = this._createView(componentDef, name, sibling.parent, overrides);
        view.variant0.left = sibling.variant0.left;
        view.variant0.top = sibling.variant0.top - view.variant0.height - (overrides.Gap || this.margin);
        return this._inject(sibling.parent, view);
    }

    addLeft(componentDef, name, siblingName, overrides = {}) {
        const sibling = this._findView(this.layout.Data, siblingName);
        if (!sibling) throw new Error(`Sibling not found: ${siblingName}`);
        const view = this._createView(componentDef, name, sibling.parent, overrides);
        view.variant0.top = sibling.variant0.top;
        view.variant0.left = sibling.variant0.left - view.variant0.width - (overrides.Gap || this.margin);
        return this._inject(sibling.parent, view);
    }

    setLeft(name, left) {
        const view = this._findView(this.layout.Data, name);
        if (!view) throw new Error(`View not found: ${name}`);
        view.variant0.left = left;
    }

    setTop(name, top) {
        const view = this._findView(this.layout.Data, name);
        if (!view) throw new Error(`View not found: ${name}`);
        view.variant0.top = top;
    }

    setWidth(name, width) {
        const view = this._findView(this.layout.Data, name);
        if (!view) throw new Error(`View not found: ${name}`);
        view.variant0.width = width;
    }

    setHeight(name, height) {
        const view = this._findView(this.layout.Data, name);
        if (!view) throw new Error(`View not found: ${name}`);
        view.variant0.height = height;
    }

    setRectangle(name, left, top, width, height) {
        const view = this._findView(this.layout.Data, name);
        if (!view) throw new Error(`View not found: ${name}`);
        view.variant0.left = left; view.variant0.top = top;
        view.variant0.width = width; view.variant0.height = height;
    }

    /**
     * Compatibility method for setRectangle (Left, Top, Width, Height).
     */
    setRectangleLTWH(name, left, top, width, height) {
        this.setRectangle(name, left, top, width, height);
    }

    /**
     * Sets the position using Left, Top, Right, Bottom boundaries.
     */
    setRectangleLTRB(name, left, top, right, bottom) {
        this.setRectangle(name, left, top, right - left, bottom - top);
    }

    /**
     * Sets the right boundary of the component (adjusts width).
     */
    setRight(name, right) {
        const view = this._findView(this.layout.Data, name);
        if (!view) throw new Error(`View not found: ${name}`);
        view.variant0.width = right - view.variant0.left;
    }

    /**
     * Sets the bottom boundary of the component (adjusts height).
     */
    setBottom(name, bottom) {
        const view = this._findView(this.layout.Data, name);
        if (!view) throw new Error(`View not found: ${name}`);
        view.variant0.height = bottom - view.variant0.top;
    }

    /**
     * Sets a custom property value by key.
     */
    setProperty(name, key, value) {
        const view = this._findView(this.layout.Data, name);
        if (!view) throw new Error(`View not found: ${name}`);

        // Sync with top-level fields if applicable
        if (key === "Text" || key === "Label" || key === "Title") view.text = value;
        if (key === "Tag") view.tag = value;
        if (key === "Visible" && typeof value === 'boolean') view.visible = value;
        if (key === "Enabled" && typeof value === 'boolean') view.enabled = value;

        if (view.customProperties) {
            view.customProperties[key] = value;
        }
    }

    /**
     * Sets multiple custom properties at once.
     */
    setProperties(name, props = {}) {
        for (const [key, value] of Object.entries(props)) {
            this.setProperty(name, key, value);
        }
    }

    /**
     * Duplicates an existing element, creating a deep copy.
     */
    duplicate(sourceName, newName, overrides = {}) {
        const sourceView = this._findView(this.layout.Data, sourceName);
        if (!sourceView) throw new Error(`Source view not found: ${sourceName}`);

        // Deep clone the source view
        const newView = JSON.parse(JSON.stringify(sourceView));
        
        // Update identifying properties
        newView.name = newName;
        newView.eventName = newName;
        newView.customProperties.eventName = newName;
        
        // Ensure header exists
        this._ensureHeader(newName, sourceView.shortType);

        // Apply overrides and default offset
        Object.assign(newView.variant0, {
            left: sourceView.variant0.left + this.margin,
            top: sourceView.variant0.top + this.margin
        }, overrides);

        // Inject into parent
        return this._inject(sourceView.parent, newView);
    }

    /**
     * Brings an element to the front (renders on top of siblings).
     */
    bringToFront(name) {
        const view = this._findView(this.layout.Data, name);
        if (!view) throw new Error(`View not found: ${name}`);
        const parent = this._findView(this.layout.Data, view.parent || "Main");
        if (!parent || !parent[':kids']) return;

        const kids = parent[':kids'];
        const keys = Object.keys(kids).sort((a, b) => parseInt(a) - parseInt(b));
        const newKids = {};
        let foundIdx = -1;
        
        // Find current key
        for (const k of keys) {
            if (kids[k].name === name) {
                foundIdx = k;
                break;
            }
        }

        if (foundIdx === -1) return;

        // Reconstruct: everyone except the found one, then the found one at the end
        let current = 0;
        for (const k of keys) {
            if (k !== foundIdx) {
                newKids[String(current++)] = kids[k];
            }
        }
        newKids[String(current)] = kids[foundIdx];
        parent[':kids'] = newKids;
    }

    /**
     * Sends an element to the back (renders behind siblings).
     */
    sendToBack(name) {
        const view = this._findView(this.layout.Data, name);
        if (!view) throw new Error(`View not found: ${name}`);
        const parent = this._findView(this.layout.Data, view.parent || "Main");
        if (!parent || !parent[':kids']) return;

        const kids = parent[':kids'];
        const keys = Object.keys(kids).sort((a, b) => parseInt(a) - parseInt(b));
        const newKids = {};
        let foundIdx = -1;
        
        // Find current key
        for (const k of keys) {
            if (kids[k].name === name) {
                foundIdx = k;
                break;
            }
        }

        if (foundIdx === -1) return;

        // Reconstruct: found one first, then everyone else
        let current = 0;
        newKids[String(current++)] = kids[foundIdx];
        for (const k of keys) {
            if (k !== foundIdx) {
                newKids[String(current++)] = kids[k];
            }
        }
        parent[':kids'] = newKids;
    }

    _ensureHeader(name, componentType) {
        if (!this.layout.LayoutHeader.ControlsHeaders.some(h => h.Name === name)) {
            this.layout.LayoutHeader.ControlsHeaders.push({
                Name: name, JavaType: '.CustomViewWrapper', DesignerType: 'CustomView'
            });
        }
    }

    _findView(root, name) {
        if (root.name === name) return root;
        if (root[':kids']) {
            for (const kid of Object.values(root[':kids'])) {
                const found = this._findView(kid, name);
                if (found) return found;
            }
        }
        return null;
    }
}

/* ---------- Export ---------- */
const SithasoLib = {
    Engine: SithasoLayoutEngine,
    Converter: BJLConverter,
    Types: TYPE_CODES
};

if (typeof module !== 'undefined') {
    module.exports = SithasoLib;
    module.exports.BJLConverter = BJLConverter;
    module.exports.TYPE_CODES = TYPE_CODES;
}
if (typeof window !== 'undefined') {
    window.SithasoLib = SithasoLib;
    window.BJLConverter = BJLConverter;
    window.TYPE_CODES = TYPE_CODES;
}
