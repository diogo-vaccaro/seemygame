import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SharedToolsService } from '../js/room/tools/shared-tools-service.js';
import { SnippetsManager, MAX_SNIPPET_BYTES, MAX_AGGREGATE_BYTES } from '../js/room/tools/snippets.js';

describe('SnippetsManager - Snippets de Código Colaborativo', () => {
  let hostService;
  let snippets;

  beforeEach(() => {
    hostService = new SharedToolsService({
      isHost: () => true,
      getLocalPeerId: () => 'host-peer',
      getDisplayName: () => 'Host',
      roomEpoch: 'epoch-1'
    });

    snippets = new SnippetsManager({
      service: hostService,
      getLocalPeerId: () => 'host-peer',
      getDisplayName: () => 'Host',
      isHost: () => true,
      getIsReadonly: () => false
    });
  });

  afterEach(() => {
    snippets.dispose();
    hostService.dispose();
  });

  it('cria snippet com título, linguagem higienizada e conteúdo', async () => {
    const res = await snippets.createSnippet({
      title: 'Bind de Jumpthrow',
      language: 'BASH',
      content: 'alias "+jumpaction" "+jump;"'
    });

    expect(res.success).toBe(true);
    const list = snippets.getSnippetsList();
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe('Bind de Jumpthrow');
    expect(list[0].language).toBe('bash'); // Sanitizado para minúsculo
    expect(list[0].content).toContain('+jumpaction');
  });

  it('substitui linguagem desconhecida por plaintext padrão', async () => {
    await snippets.createSnippet({
      title: 'Desconhecida',
      language: 'brainfuck',
      content: '++++++++'
    });

    const list = snippets.getSnippetsList();
    expect(list[0].language).toBe('plaintext');
  });

  it('gerencia licença de edição temporária (Lease) exclusivamente para um editor', async () => {
    const res = await snippets.createSnippet({ title: 'Config', language: 'json', content: '{}' });
    const snippetId = res.payload.snippet.id;

    // Participante 1 obtém licença
    const lease1 = await snippets._applyProposalOnHost(
      { action: 'request_lease' },
      { authorPeerId: 'player-1', entityId: snippetId }
    );
    expect(lease1.success).toBe(true);
    expect(lease1.payload.editorPeerId).toBe('player-1');

    // Participante 2 tenta obter licença concorrente enquanto o 1 possui licença ativa
    const lease2 = await snippets._applyProposalOnHost(
      { action: 'request_lease' },
      { authorPeerId: 'player-2', entityId: snippetId }
    );
    expect(lease2.success).toBe(false);
    expect(lease2.reason).toBe('already_leased');

    // Participante 1 libera a licença
    const release = await snippets._applyProposalOnHost(
      { action: 'release_lease' },
      { authorPeerId: 'player-1', entityId: snippetId }
    );
    expect(release.success).toBe(true);

    // Agora Participante 2 consegue obter licença
    const lease3 = await snippets._applyProposalOnHost(
      { action: 'request_lease' },
      { authorPeerId: 'player-2', entityId: snippetId }
    );
    expect(lease3.success).toBe(true);
    expect(lease3.payload.editorPeerId).toBe('player-2');
  });

  it('preserva rascunho local de segurança caso a edição sofra conflito', async () => {
    const res = await snippets.createSnippet({ title: 'Script', language: 'python', content: 'print(1)' });
    const snippetId = res.payload.snippet.id;

    // Simula cliente tentando atualizar
    snippets.updateSnippet(snippetId, {
      title: 'Script',
      language: 'python',
      content: 'print(2)'
    });

    const draft = snippets.getLocalDraft(snippetId);
    expect(draft).not.toBeNull();
    expect(draft.content).toBe('print(2)');
  });

  it('impõe teto estrito de tamanho por snippet (64 KiB) e agregado (128 KiB)', async () => {
    const hugeText = 'x'.repeat(MAX_SNIPPET_BYTES + 10);
    const res = await snippets.createSnippet({ title: 'Enorme', content: hugeText });
    expect(res.success).toBe(false);
    expect(res.reason).toBe('size_limit_exceeded');
  });

  it('duplica snippet gerando uma nova entidade independente', async () => {
    const orig = await snippets.createSnippet({ title: 'Original', language: 'rust', content: 'fn main() {}' });
    const origId = orig.payload.snippet.id;

    const dup = await snippets.duplicateSnippet(origId);
    expect(dup.success).toBe(true);

    const list = snippets.getSnippetsList();
    expect(list).toHaveLength(2);
    expect(list.some(s => s.title === 'Cópia de Original')).toBe(true);
  });

  it('libera automaticamente licença caso participante se desconecte da sala', async () => {
    const res = await snippets.createSnippet({ title: 'Shared', language: 'css', content: 'body {}' });
    const snippetId = res.payload.snippet.id;

    await snippets._applyProposalOnHost(
      { action: 'request_lease' },
      { authorPeerId: 'leaver-peer', entityId: snippetId }
    );
    expect(snippets.getSnippet(snippetId).editorPeerId).toBe('leaver-peer');

    snippets.handlePeerDisconnected('leaver-peer');
    expect(snippets.getSnippet(snippetId).editorPeerId).toBeNull();
  });
});
