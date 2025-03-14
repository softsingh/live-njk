import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs-extra';
import * as nunjucks from 'nunjucks';
import * as chokidar from 'chokidar';

let watcher: chokidar.FSWatcher | undefined;
let statusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;
let fileDepTree: Map<string, string[]> = new Map(); // Map of file dependencies
let njkEnv: nunjucks.Environment;

export function activate(context: vscode.ExtensionContext) {
	console.log('Live Njk extension is now active!');

	// Create output channel
	outputChannel = vscode.window.createOutputChannel('Live Njk');

	// Create status bar item
	statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBarItem.text = "$(eye) Live Njk";
	statusBarItem.tooltip = "Live Njk Compiler";
	statusBarItem.command = 'live-njk.toggleCompiler';
	context.subscriptions.push(statusBarItem);

	// Register commands
	let startCommand = vscode.commands.registerCommand('live-njk.startCompiler', startCompiler);
	let stopCommand = vscode.commands.registerCommand('live-njk.stopCompiler', stopCompiler);
	let toggleCommand = vscode.commands.registerCommand('live-njk.toggleCompiler', toggleCompiler);
	let compileAllCommand = vscode.commands.registerCommand('live-njk.compileAll', compileAllFiles);

	context.subscriptions.push(startCommand, stopCommand, toggleCommand, compileAllCommand);

	// Check configuration for auto-start
	const config = vscode.workspace.getConfiguration('liveNjk');
	if (config.get('autoStartWatcher', true)) {
		startCompiler();
	} else {
		statusBarItem.text = "$(eye-closed) Live Njk";
		statusBarItem.show();
	}
}

export function deactivate() {
	stopCompiler();
}

// Create a custom Nunjucks file loader that doesn't cache
class NoCacheLoader extends nunjucks.FileSystemLoader {
	constructor(searchPaths: string | string[], opts?: nunjucks.LoaderOptions) {
		// Set noCache to true in the options
		const options = opts || {};
		options.noCache = true;

		super(searchPaths, options);
	}
}

// Build dependency tree of all .njk files
async function buildDependencyTree(rootPath: string, njkGlob: string): Promise<void> {
	outputChannel.appendLine('Building dependency tree...');

	// Clear existing dependency tree
	fileDepTree.clear();

	try {
		// Find all .njk files
		const njkFiles = await vscode.workspace.findFiles(njkGlob);

		// Process each file to find its dependencies and reverse dependencies
		for (const file of njkFiles) {
			const filePath = file.fsPath;
			const deps = await findDependencies(filePath, rootPath);

			// Add this file's dependencies
			fileDepTree.set(filePath, deps);

			// For each dependency, add this file as a reverse dependency
			deps.forEach(depPath => {
				// Initialize reverse dependency entry if it doesn't exist
				if (!fileDepTree.has(depPath)) {
					fileDepTree.set(depPath, []);
				}
			});
		}

		outputChannel.appendLine(`Dependency tree built with ${fileDepTree.size} files`);
	} catch (error) {
		outputChannel.appendLine(`Error building dependency tree: ${error}`);
	}
}

// Find all files that this file depends on (includes and extends)
async function findDependencies(filePath: string, rootPath: string): Promise<string[]> {
	try {
		if (!fs.existsSync(filePath)) {
			return [];
		}

		const content = await fs.readFile(filePath, 'utf-8');

		// Regular expressions to match Nunjucks include and extend statements
		const includeRegex = /{%\s+include\s+['"](.+?)['"]\s+%}/g;
		const extendsRegex = /{%\s+extends\s+['"](.+?)['"]\s+%}/g;

		const deps: string[] = [];
		let match;

		// Find all includes
		while ((match = includeRegex.exec(content)) !== null) {
			deps.push(match[1]);
		}

		// Find all extends
		while ((match = extendsRegex.exec(content)) !== null) {
			deps.push(match[1]);
		}

		// Convert relative paths to absolute
		return deps.map(includePath => {
			// If the include doesn't have an extension, add .njk
			if (!path.extname(includePath)) {
				includePath += '.njk';
			}

			// If it doesn't start with an underscore and it's a partial, add it
			const basename = path.basename(includePath);
			if (!basename.startsWith('_')) {
				const dirname = path.dirname(includePath);
				const partialPath = path.join(dirname, `_${basename}`);
				return path.resolve(path.dirname(filePath), partialPath);
			}

			// Handle relative paths
			return path.resolve(path.dirname(filePath), includePath);
		});
	} catch (error) {
		outputChannel.appendLine(`Error finding dependencies for ${filePath}: ${error}`);
		return [];
	}
}

// Find all files that depend on this file (reverse dependencies)
function findReverseDependencies(filePath: string): string[] {
	const reverseDeps: string[] = [];

	// Check each entry in the dependency tree
	fileDepTree.forEach((deps, file) => {
		// If this file depends on our target file, add it to reverse dependencies
		if (deps.includes(filePath)) {
			reverseDeps.push(file);
		}
	});

	return reverseDeps;
}

// Find all files that need to be recompiled when a file changes
function findFilesToRecompile(filePath: string): string[] {
	const filesToCompile = new Set<string>();
	const fileName = path.basename(filePath);

	// If it's a partial file, find all files that include it (directly or indirectly)
	if (fileName.startsWith('_')) {
		const queue = [filePath];
		const processed = new Set<string>();

		while (queue.length > 0) {
			const currentFile = queue.shift()!;

			if (processed.has(currentFile)) {
				continue;
			}

			processed.add(currentFile);

			// Find all files that directly depend on this file
			const reverseDeps = findReverseDependencies(currentFile);

			for (const dep of reverseDeps) {
				// Add this file to the compilation list if it's not a partial
				const depName = path.basename(dep);
				if (!depName.startsWith('_')) {
					filesToCompile.add(dep);
				}

				// Add to queue to process its reverse dependencies
				queue.push(dep);
			}
		}
	} else {
		// If it's a regular file, just compile it
		filesToCompile.add(filePath);
	}

	return Array.from(filesToCompile);
}

async function compileAllFiles() {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders) {
		vscode.window.showErrorMessage('Live Njk: No workspace folder found');
		return;
	}

	const rootPath = workspaceFolders[0].uri.fsPath;
	const config = vscode.workspace.getConfiguration('liveNjk');
	const outputDir = config.get<string>('outputDirectory', 'dist');
	const njkGlob = config.get<string>('filesGlob', '**/*.njk');
	const excludePartials = config.get<boolean>('excludePartials', true);

	try {
		// Find all .njk files
		const njkFiles = await vscode.workspace.findFiles(njkGlob);

		// Create fresh Nunjucks environment
		createNunjucksEnvironment(rootPath);

		// Compile all non-partial files
		let compiledCount = 0;

		for (const file of njkFiles) {
			const filePath = file.fsPath;
			const fileName = path.basename(filePath);

			if (!excludePartials || !fileName.startsWith('_')) {
				await compileNjkFile(filePath, rootPath, outputDir);
				compiledCount++;
			}
		}

		outputChannel.appendLine(`Compiled ${compiledCount} files`);
		vscode.window.showInformationMessage(`Live Njk: Compiled ${compiledCount} files`);
	} catch (error) {
		outputChannel.appendLine(`Error compiling all files: ${error}`);
		vscode.window.showErrorMessage(`Live Njk: ${error}`);
	}
}

function createNunjucksEnvironment(rootPath: string): void {
	// Create a Nunjucks environment with caching disabled
	njkEnv = new nunjucks.Environment(new NoCacheLoader(rootPath, { noCache: true }), {
		autoescape: true,
		noCache: true // Explicitly disable caching
	});

	outputChannel.appendLine('Created fresh Nunjucks environment');
}

async function startCompiler() {
	if (watcher) {
		return; // Already running
	}

	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders) {
		vscode.window.showErrorMessage('Live Njk: No workspace folder found');
		return;
	}

	// Get configuration
	const config = vscode.workspace.getConfiguration('liveNjk');
	const outputDir = config.get<string>('outputDirectory', 'dist');
	const njkGlob = config.get<string>('filesGlob', '**/*.njk');
	const excludePartials = config.get<boolean>('excludePartials', true);

	try {
		// Start watching files
		const rootPath = workspaceFolders[0].uri.fsPath;

		// Create Nunjucks environment
		createNunjucksEnvironment(rootPath);

		// Build initial dependency tree
		await buildDependencyTree(rootPath, njkGlob);

		// Create watcher
		const watchPattern = path.join(rootPath, njkGlob);
		watcher = chokidar.watch(watchPattern, {
			ignored: /(^|[\/\\])\../, // Ignore dotfiles
			persistent: true
		});

		// Log startup
		outputChannel.appendLine(`Live Njk started: Watching ${njkGlob}`);
		outputChannel.appendLine(`Output directory: ${outputDir}`);
		outputChannel.show(true);

		// Update status bar
		statusBarItem.text = "$(eye) Live Njk";
		statusBarItem.show();

		// Handle file changes
		watcher.on('change', async (filePath) => {
			try {
				outputChannel.appendLine(`File changed: ${filePath}`);

				// Update dependency tree for this file
				const deps = await findDependencies(filePath, rootPath);
				fileDepTree.set(filePath, deps);

				// Force clear Nunjucks template cache for this file
				createNunjucksEnvironment(rootPath);

				// Find all files that need to be recompiled
				const filesToCompile = findFilesToRecompile(filePath);

				if (filesToCompile.length === 0) {
					outputChannel.appendLine(`No files to compile for change in: ${filePath}`);
				} else {
					outputChannel.appendLine(`Need to compile ${filesToCompile.length} files due to change in: ${filePath}`);

					// Compile each file
					for (const fileToCompile of filesToCompile) {
						const fileName = path.basename(fileToCompile);
						if (!excludePartials || !fileName.startsWith('_')) {
							await compileNjkFile(fileToCompile, rootPath, outputDir);
						}
					}
				}
			} catch (error) {
				outputChannel.appendLine(`Error processing ${filePath}: ${error}`);
			}
		});

		// Also rebuild dependency tree when files are added or deleted
		watcher.on('add', async (filePath) => {
			try {
				const deps = await findDependencies(filePath, rootPath);
				fileDepTree.set(filePath, deps);
				outputChannel.appendLine(`Added file to dependency tree: ${filePath}`);
			} catch (error) {
				outputChannel.appendLine(`Error adding file to dependency tree: ${error}`);
			}
		});

		watcher.on('unlink', (filePath) => {
			fileDepTree.delete(filePath);
			outputChannel.appendLine(`Removed file from dependency tree: ${filePath}`);
		});

		vscode.window.showInformationMessage('Live Njk Compiler started');
	} catch (error) {
		outputChannel.appendLine(`Startup error: ${error}`);
		vscode.window.showErrorMessage(`Live Njk: ${error}`);
	}
}

function stopCompiler() {
	if (watcher) {
		watcher.close();
		watcher = undefined;

		// Update status bar
		statusBarItem.text = "$(eye-closed) Live Njk";

		// Log
		outputChannel.appendLine('Live Njk Compiler stopped');
		vscode.window.showInformationMessage('Live Njk Compiler stopped');
	}
}

function toggleCompiler() {
	if (watcher) {
		stopCompiler();
	} else {
		startCompiler();
	}
}

async function compileNjkFile(filePath: string, rootPath: string, outputDir: string) {
	try {
		// Calculate relative path from workspace root
		const relativePath = path.relative(rootPath, filePath);
		outputChannel.appendLine(`Compiling: ${relativePath}`);

		// Read the template content directly from disk to avoid Nunjucks caching
		const templateContent = await fs.readFile(filePath, 'utf-8');

		// Calculate template name (relative to root path)
		const templateName = relativePath;

		// Calculate the directory containing the template for correct include resolution
		const templateDir = path.dirname(filePath);

		// Render the template directly from content to bypass any Nunjucks caching
		const result = njkEnv.renderString(templateContent, {
			// Add a context object with useful properties
			_self: {
				path: filePath,
				directory: templateDir
			}
		});

		// Calculate output path
		const outputFileName = path.basename(filePath, '.njk') + '.html';
		const relativeDir = path.dirname(relativePath);
		const outputPath = path.join(rootPath, outputDir, relativeDir, outputFileName);

		// Ensure output directory exists
		await fs.ensureDir(path.dirname(outputPath));

		// Write the compiled HTML to the output file
		await fs.writeFile(outputPath, result, 'utf-8');

		outputChannel.appendLine(`Compiled to: ${path.relative(rootPath, outputPath)}`);
	} catch (error) {
		outputChannel.appendLine(`Failed to compile ${filePath}: ${error}`);
		throw new Error(`Failed to compile ${filePath}: ${error}`);
	}
}