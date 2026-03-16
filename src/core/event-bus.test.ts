import { strict as assert } from 'assert';
import { EventBus } from './event-bus.ts';

// Simple test suite for EventBus
const bus = new EventBus();

// Test on and emit
let renderCalled = false;
const offRender = bus.on('render:request', () => {
  renderCalled = true;
});
bus.emit('render:request');
assert.ok(renderCalled, 'render:request listener should be called');

// Test off
renderCalled = false;
offRender(); // unsubscribe
bus.emit('render:request');
assert.ok(!renderCalled, 'listener should not be called after off');

// Test once
let turnStartCount = 0;
bus.once('turn:start', (data) => {
  turnStartCount++;
  assert.equal(data.prompt, 'hello');
});
bus.emit('turn:start', { prompt: 'hello' });
bus.emit('turn:start', { prompt: 'hello' });
assert.equal(turnStartCount, 1, 'once listener should be called only once');

console.log('All EventBus tests passed');
