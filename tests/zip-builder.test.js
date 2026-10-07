import { describe, it, expect } from 'vitest';
import { ZipBuilder, calculateCrc32 } from '../js/utils/zip-builder.js';

describe('ZipBuilder (PKZIP 2.0 Store format)', () => {
  it('calcula CRC32 corretamente', () => {
    const text = new TextEncoder().encode('Hello World');
    const crc = calculateCrc32(text);
    expect(crc).toBe(0x4A17B156);
  });

  it('cria um arquivo ZIP com múltiplos arquivos sem dependências', async () => {
    const zip = new ZipBuilder();
    await zip.addFile('teste.txt', 'Conteúdo do arquivo de teste');
    await zip.addFile('subpasta/outro.txt', new TextEncoder().encode('Outro arquivo em subpasta'));
    
    const fakeVideoBlob = new Blob(['FAKE_VIDEO_STREAM_DATA'], { type: 'video/webm' });
    await zip.addFile('video_master.webm', fakeVideoBlob);

    const zipBlob = zip.build();
    expect(zipBlob).toBeInstanceOf(Blob);
    expect(zipBlob.type).toBe('application/zip');
    expect(zipBlob.size).toBeGreaterThan(100);

    // Validar assinatura inicial (PK\x03\x04)
    const arrayBuffer = await zipBlob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    expect(bytes[0]).toBe(0x50); // 'P'
    expect(bytes[1]).toBe(0x4B); // 'K'
    expect(bytes[2]).toBe(0x03);
    expect(bytes[3]).toBe(0x04);
  });
});
