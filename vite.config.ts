import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	server: {
		port: 51987,
		strictPort: true
	},
	worker: {
		format: 'es'
	}
});
