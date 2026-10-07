/**
 * SeeMyGame - ZipBuilder
 * Construtor leve de arquivos ZIP (PKZIP 2.0 Store) em JavaScript puro.
 * Permite empacotar múltiplos Blobs (áudio, vídeo, texto) em um único arquivo .zip
 * sem nenhuma dependência de terceiros.
 */

// Tabela estática para cálculo rápido de CRC-32
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[i] = c >>> 0;
}

export function calculateCrc32(uint8Array) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < uint8Array.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ uint8Array[i]) & 0xFF];
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

export class ZipBuilder {
  constructor() {
    this.entries = []; // Array de { name, data: Uint8Array, date, crc, size }
  }

  /**
   * Adiciona um arquivo ao arquivo ZIP.
   * @param {string} name - Caminho/nome do arquivo dentro do zip
   * @param {Blob|Uint8Array|ArrayBuffer|string} content - Conteúdo do arquivo
   * @param {Date} [date] - Data de modificação do arquivo
   */
  async addFile(name, content, date = new Date()) {
    let uint8Array;
    if (content && typeof content.arrayBuffer === 'function') {
      const buffer = await content.arrayBuffer();
      uint8Array = new Uint8Array(buffer);
    } else if (ArrayBuffer.isView(content)) {
      uint8Array = new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
    } else if (content instanceof ArrayBuffer) {
      uint8Array = new Uint8Array(content);
    } else if (typeof content === 'string') {
      uint8Array = new TextEncoder().encode(content);
    } else {
      throw new Error(`Tipo de conteúdo não suportado para o arquivo ${name}`);
    }

    const crc = calculateCrc32(uint8Array);
    const cleanName = String(name || 'unnamed')
      .replace(/\\/g, '/')
      .replace(/^[/\\]+/, '');

    this.entries.push({
      name: cleanName || 'file',
      data: uint8Array,
      date: date instanceof Date ? date : new Date(),
      crc,
      size: uint8Array.length
    });
  }

  /**
   * Constrói e retorna o arquivo ZIP completo como Blob.
   * @returns {Blob}
   */
  build() {
    const localHeadersAndData = [];
    const centralDirectoryEntries = [];
    let currentOffset = 0;

    for (const entry of this.entries) {
      const nameBytes = new TextEncoder().encode(entry.name);
      const nameLength = nameBytes.length;
      const dataLength = entry.size;

      // Conversão de data para formato MS-DOS (tempo e data) com máscaras de segurança
      const year = entry.date.getFullYear();
      const month = entry.date.getMonth() + 1;
      const day = entry.date.getDate();
      const hours = entry.date.getHours();
      const minutes = entry.date.getMinutes();
      const seconds = Math.floor(entry.date.getSeconds() / 2);

      const dosYear = Math.min(127, Math.max(0, year - 1980));
      const dosTime = ((hours & 0x1F) << 11) | ((minutes & 0x3F) << 5) | (seconds & 0x1F);
      const dosDate = (dosYear << 9) | ((month & 0x0F) << 5) | (day & 0x1F);

      // --- Local File Header (30 bytes + nome + dados) ---
      const localHeader = new Uint8Array(30 + nameLength);
      const lv = new DataView(localHeader.buffer);

      lv.setUint32(0, 0x04034b50, true);  // Local file header signature
      lv.setUint16(4, 20, true);          // Version needed to extract (2.0)
      lv.setUint16(6, 0x0800, true);      // General purpose bit flag (UTF-8)
      lv.setUint16(8, 0, true);           // Compression method (0 = Store)
      lv.setUint16(10, dosTime, true);    // Last mod file time
      lv.setUint16(12, dosDate, true);    // Last mod file date
      lv.setUint32(14, entry.crc, true);  // CRC-32
      lv.setUint32(18, dataLength, true); // Compressed size
      lv.setUint32(22, dataLength, true); // Uncompressed size
      lv.setUint16(26, nameLength, true); // File name length
      lv.setUint16(28, 0, true);          // Extra field length
      localHeader.set(nameBytes, 30);

      localHeadersAndData.push(localHeader, entry.data);

      // --- Central Directory Header (46 bytes + nome) ---
      const cdHeader = new Uint8Array(46 + nameLength);
      const cv = new DataView(cdHeader.buffer);

      cv.setUint32(0, 0x02014b50, true);    // Central dir signature
      cv.setUint16(4, 20, true);            // Version made by
      cv.setUint16(6, 20, true);            // Version needed to extract
      cv.setUint16(8, 0x0800, true);        // General purpose bit flag (UTF-8)
      cv.setUint16(10, 0, true);            // Compression method (Store)
      cv.setUint16(12, dosTime, true);      // Last mod file time
      cv.setUint16(14, dosDate, true);      // Last mod file date
      cv.setUint32(16, entry.crc, true);    // CRC-32
      cv.setUint32(20, dataLength, true);   // Compressed size
      cv.setUint32(24, dataLength, true);   // Uncompressed size
      cv.setUint16(28, nameLength, true);   // File name length
      cv.setUint16(30, 0, true);            // Extra field length
      cv.setUint16(32, 0, true);            // Comment length
      cv.setUint16(34, 0, true);            // Disk number start
      cv.setUint16(36, 0, true);            // Internal file attributes
      cv.setUint32(38, 0, true);            // External file attributes
      cv.setUint32(42, currentOffset, true);// Relative offset of local header
      cdHeader.set(nameBytes, 46);

      centralDirectoryEntries.push(cdHeader);

      currentOffset += localHeader.length + dataLength;
    }

    // Tamanho total do diretório central
    const cdSize = centralDirectoryEntries.reduce((acc, curr) => acc + curr.length, 0);

    // --- End of Central Directory Record (22 bytes) ---
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);

    ev.setUint32(0, 0x06054b50, true);             // EOCD signature
    ev.setUint16(4, 0, true);                      // Number of this disk
    ev.setUint16(6, 0, true);                      // Disk where CD starts
    ev.setUint16(8, this.entries.length, true);    // Number of CD records on disk
    ev.setUint16(10, this.entries.length, true);   // Total number of CD records
    ev.setUint32(12, cdSize, true);                // Size of central directory
    ev.setUint32(16, currentOffset, true);         // Offset of CD relative to start
    ev.setUint16(20, 0, true);                     // Comment length

    // Concatenação em um único Blob
    const allParts = [...localHeadersAndData, ...centralDirectoryEntries, eocd];
    return new Blob(allParts, { type: 'application/zip' });
  }

  buildBlob() {
    return this.build();
  }

  download(filename, blob = null) {
    const fileBlob = blob || this.build();
    if (typeof document === 'undefined') return;
    const url = URL.createObjectURL(fileBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'archive.zip';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  }
}
