import {describe,it,expect} from 'vitest';
import {readRawQueueEvidence} from '../tools/e2e/harness/capture-backend.mjs';
const line=policy=>`[GStreamer Pipeline] d3d12screencapturesrc ! queue ${policy} ! videorate ! d3d12convert ! queue ${policy} ! d3d12download ! nvd3d11h264enc ! rtph264pay ! queue max-size-time=120000000`;
const bounded='max-size-buffers=3 max-size-time=50000000 max-size-bytes=0';
const latest='max-size-buffers=1 max-size-time=0 max-size-bytes=0 leaky=downstream';
describe('actual raw video queue evidence',()=>{
 it('accepts only the requested two queues before encode',()=>{
  expect(readRawQueueEvidence([line(bounded)],'bounded').matched).toBe(true);
  expect(readRawQueueEvidence([line(latest)],'latest').matched).toBe(true);
  expect(readRawQueueEvidence([line(bounded)],'latest').matched).toBe(false);
 });
 it('rejects missing, mixed or unexpected policies',()=>{
  expect(readRawQueueEvidence([],'latest').matched).toBe(false);
  expect(readRawQueueEvidence([line(latest),line(bounded)],'latest').matched).toBe(false);
  expect(readRawQueueEvidence([line(bounded+' leaky=downstream')],'bounded').matched).toBe(false);
  expect(()=>readRawQueueEvidence([], 'auto')).toThrow();
 });
 it('does not mistake an encoded RTP queue for a raw queue',()=>{
  expect(readRawQueueEvidence([line(latest).replace('! queue '+latest,'')],'latest').matched).toBe(false);
 });
});
