import { writeFileSync } from 'node:fs';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

/** @type {import('.').default} */
export default function (options) {
	return {
		name: '@sveltejs/adapter-cloudflare',
		async adapt(builder) {
			const files = fileURLToPath(new URL('./files', import.meta.url).href);
			const dest = builder.getBuildDirectory('cloudflare');
			const tmp = builder.getBuildDirectory('cloudflare-tmp');

			builder.rimraf(dest);
			builder.rimraf(tmp);
			builder.mkdirp(tmp);

			const dest_dir = `${dest}${builder.config.kit.paths.base}`;
			const written_files = builder.writeClient(dest_dir);
			builder.writePrerendered(dest_dir);

			const relativePath = posix.relative(tmp, builder.getServerDirectory());

			writeFileSync(
				`${tmp}/manifest.js`,
				`export const manifest = ${builder.generateManifest({ relativePath })};\n\n` +
					`export const prerendered = new Set(${JSON.stringify(builder.prerendered.paths)});\n`
			);

			writeFileSync(
				`${dest}/_routes.json`,
				JSON.stringify(get_routes_json(builder, written_files, options))
			);

			writeFileSync(`${dest}/_headers`, generate_headers(builder.config.kit.appDir), { flag: 'a' });

			builder.copy(`${files}/worker.js`, `${tmp}/_worker.js`, {
				replace: {
					SERVER: `${relativePath}/index.js`,
					MANIFEST: './manifest.js'
				}
			});

			await esbuild.build({
				platform: 'browser',
				conditions: ['worker', 'browser'],
				sourcemap: 'linked',
				target: 'es2020',
				entryPoints: [`${tmp}/_worker.js`],
				outfile: `${dest}/_worker.js`,
				allowOverwrite: true,
				format: 'esm',
				bundle: true
			});
		}
	};
}

/**
 * @param {import('@sveltejs/kit').Builder} builder
 * @param {string[]} assets
 * @param {import('./index').AdapterOptions} options
 * @returns {import('.').RoutesJSONSpec}
 */
function get_routes_json(builder, assets, options) {
	/** @type {import('./index').AdapterOptions['routes']} */
	let { include = ['/*'], exclude = ['<all>'] } = options?.routes ?? {};

	// _app
	if (exclude.includes('<build>') || exclude.includes('<all>')) {
		// splice is used to preserve the order that was specified
		exclude.splice(
			exclude.includes('<build>') ? exclude.indexOf('<build>') : exclude.indexOf('<all>'),
			exclude.includes('<build>') ? 1 : 0,
			`/${builder.config.kit.appDir}/*`
		);
	}

	// static files
	if (exclude.includes('<files>') || exclude.includes('<all>')) {
		exclude.splice(
			exclude.includes('<files>') ? exclude.indexOf('<files>') : exclude.indexOf('<all>'),
			exclude.includes('<files>') ? 1 : 0,
			...assets
				.filter(
					(file) =>
						!(
							file.startsWith(`${builder.config.kit.appDir}/`) ||
							file === '_headers' ||
							file === '_redirects'
						)
				)
				.map((file) => `/${file}`)
		);
	}

	// prerendered pages/paths
	if (exclude.includes('<prerendered>') || exclude.includes('<all>')) {
		const prerendered = [];
		for (const path of builder.prerendered.paths) {
			if (!builder.prerendered.redirects.has(path)) {
				prerendered.push(path);
			}
		}

		exclude.splice(
			exclude.includes('<prerendered>')
				? exclude.indexOf('<prerendered>')
				: exclude.indexOf('<all>'),
			exclude.includes('<prerendered>') ? 1 : 0,
			...prerendered
		);
	}

	// remove <all>
	const allIndex = exclude.indexOf('<all>');
	if (allIndex > -1) {
		exclude.splice(allIndex, 1);
	}

	if (include.length + exclude.length > 100) {
		const message = `Function includes/excludes exceeds _routes.json limits (see https://developers.cloudflare.com/pages/platform/functions/routing/#limits). Skipping the overflow (will cause function invocation)`;
		builder.log.warn(message);

		while (include.length + exclude.length > 100) {
			if (include.length > exclude.length) {
				// if there are more includes than excludes, trim includes
				include.pop();
			} else {
				// if there are more excludes than includes, trim excludes
				exclude.pop();
			}
		}
	}

	if (include.length === 0) {
		builder.log.warn(
			'Routes needs at least one include rule! Adding /* to includes (see https://developers.cloudflare.com/pages/platform/functions/routing/#limits)'
		);
		include.push('/*');
	}

	return {
		version: 1,
		description: 'Generated by @sveltejs/adapter-cloudflare',
		include,
		exclude
	};
}

/** @param {string} app_dir */
function generate_headers(app_dir) {
	return `
# === START AUTOGENERATED SVELTE IMMUTABLE HEADERS ===
/${app_dir}/*
  X-Robots-Tag: noindex
	Cache-Control: no-cache
/${app_dir}/immutable/*
  ! Cache-Control
	Cache-Control: public, immutable, max-age=31536000
# === END AUTOGENERATED SVELTE IMMUTABLE HEADERS ===
`.trimEnd();
}
