import {test} from 'node:test';
import assert from 'node:assert/strict';
import {reviewFlags} from '../moderation.mjs';

test('flags personal attacks and threats while allowing ordinary vehicle criticism',()=>{
 assert.deepEqual(reviewFlags('Aracın kaportasında boya ve değişen parça var.'),[]);
 assert.ok(reviewFlags('İlan sahibi şerefsiz, kesinlikle konuşmayın.').includes('hakaret veya küfür'));
 assert.ok(reviewFlags('Seni bulurum, görürsün neler olur.').includes('tehdit'));
 assert.ok(reviewFlags('Bu adamın aklından şüphe ederim.').includes('örtülü kişisel saldırı'));
});
