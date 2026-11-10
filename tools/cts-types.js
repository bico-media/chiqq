// Writes types/index.d.cts from types/index.d.ts.
// The CJS build sets `module.exports = Chiqq`, so its types need `export =`
// rather than `export default`. Everything else is reached through the class,
// like at runtime: require('chiqq').ChiqqClearedError.
import {readFileSync, writeFileSync} from 'node:fs';

const esm = readFileSync('types/index.d.ts', 'utf8');
const names = [];
const body = esm
	.replace(/^export default Chiqq;\n?/m, '')
	.replace(/^export (declare )?(interface|type|class) (\w+)/gm, (_, declare, kind, name) => {
		names.push(name);
		return `${declare || (kind === 'class' ? 'declare ' : '')}${kind} ${name}`;
	});

if (!names.includes('Chiqq')) throw new Error('cts-types: no Chiqq class found in types/index.d.ts');

writeFileSync(
	'types/index.d.cts',
	`${body.trimEnd()}
declare namespace Chiqq {
	export {${names.join(', ')}};
	export {Chiqq as default};
}
export = Chiqq;
`
);
