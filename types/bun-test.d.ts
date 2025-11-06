declare module 'bun:test' {
	export function describe(name: string, fn: () => void): void;
	export function it(name: string, fn: () => void | Promise<void>): void;
	export function expect(value: any): any;
	export function beforeEach(fn: () => void | Promise<void>): void;
}
