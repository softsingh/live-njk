# Live Njk

A Visual Studio Code extension (created with AI) that compiles Nunjucks (.njk) templates to HTML in real-time as you save.

## Features

- Automatically watches and compiles Nunjucks files to HTML
- Skips partial files (prefixed with `_`) by default
- Configurable output directory
- Status bar indicator to show when the compiler is active
- Output panel to display compilation results and errors

## Usage

1. Install the extension
2. Open a folder containing Nunjucks (.njk) files
3. The compiler will start automatically (can be disabled in settings)
4. Edit and save .njk files to see them compiled to HTML

## Commands

- `Live Njk: Start Compiler` - Start the Nunjucks compiler
- `Live Njk: Stop Compiler` - Stop the Nunjucks compiler
- `Live Njk: Toggle Compiler` - Toggle the compiler on/off

## Extension Settings

This extension contributes the following settings:

* `liveNjk.autoStartWatcher`: Automatically start the compiler when a workspace with .njk files is opened
* `liveNjk.rootDirectory`: Directory to look for .njk files (relative to workspace root)
* `liveNjk.outputDirectory`: Directory where compiled HTML files will be saved (relative to `njk root`)
* `liveNjk.filesGlob`: Glob pattern to match Nunjucks files
* `liveNjk.excludePartials`: Skip compilation of partial files (filenames starting with _)

## How It Works

The extension watches for changes to .njk files in your workspace. When a file is saved, it compiles the template using Nunjucks and outputs an HTML file to the configured output directory.

Partial files (those starting with `_`) are not compiled directly but will trigger recompilation of files that include them.

## Release Notes

### 1.0.2

- Added formatting the output html using `js-beautify`

### 1.0.1

- Added ability to set root njk directory (`liveNjk.rootDirectory`)

### 1.0.0

- Initial release of Live Njk