import {
  BrowserBuilderOutput,
  executeBrowserBuilder,
  ExecutionTransformer
} from '@angular-devkit/build-angular';
import { JsonObject } from '@angular-devkit/core';
import { BuilderContext, createBuilder } from '@angular-devkit/architect';
import * as fs from 'fs';
import * as webpack from 'webpack';
import { tap, catchError } from 'rxjs/operators';
import { Observable, of } from 'rxjs';

let jsonOption;

let entryPointPath: string;

function buildPlugin(
  options: JsonObject,
  context: BuilderContext,
  transforms: {
    webpackConfiguration?: ExecutionTransformer<webpack.Configuration>;
  } = {}
): Observable<BrowserBuilderOutput> {
  jsonOption = options;
  // I don't want to write it in my scripts every time so I keep it here
  options.deleteOutputPath = false;

  const originalWebpackConfigurationFn = transforms.webpackConfiguration;
  transforms.webpackConfiguration = (config: webpack.Configuration) => {
    patchWebpackConfig(config);

    return originalWebpackConfigurationFn
      ? originalWebpackConfigurationFn(config)
      : config;
  };

  const result = executeBrowserBuilder(options as any, context, transforms);

  return result.pipe(
    tap(() => {
      // clear entry point so our main.ts is always empty
      patchEntryPoint('');
    })
  );
}

function patchEntryPoint(contents: string) {
  fs.writeFileSync(entryPointPath, contents);
}

function patchWebpackConfig(config: webpack.Configuration) {
  const { pluginName, sharedLibs, externals } = jsonOption;

  if (!jsonOption.modulePath) {
    throw Error('Please define modulePath!');
  }

  if (!jsonOption.pluginName) {
    throw Error('Please provide pluginName!');
  }

  // Make sure we are producing a single bundle
  delete config.entry.polyfills;
  delete config.optimization.runtimeChunk;
  delete config.optimization.splitChunks;
  delete config.entry.styles;

  config.externals = externals;

  if (sharedLibs) {
    config.externals = [config.externals];
    const sharedLibsArr = sharedLibs.split(',');
    sharedLibsArr.forEach(sharedLibName => {
      const factoryRegexp = new RegExp(`${sharedLibName}.ngfactory$`);
      config.externals[0][sharedLibName] = sharedLibName; // define external for code
      config.externals.push((context, request, callback) => {
        if (factoryRegexp.test(request)) {
          return callback(null, sharedLibName); // define external for factory
        }
        callback();
      });
    });
  }

  const ngCompilerPluginInstance = config.plugins.find(
    x => x.constructor && x.constructor.name === 'AngularCompilerPlugin'
  );
  if (ngCompilerPluginInstance) {
    ngCompilerPluginInstance._entryModule = jsonOption.modulePath;
  }

  // preserve path to entry point
  // so that we can clear use it within `run` method to clear that file
  entryPointPath = config.entry.main[0];

  const [modulePath, moduleName] = jsonOption.modulePath.split('#');

  const factoryPath = `${
    modulePath.includes('.') ? modulePath : `${modulePath}/${modulePath}`
  }.ngfactory`;
  const entryPointContents = `
      export * from '${modulePath}';
      export * from '${factoryPath}';
      import { ${moduleName}NgFactory } from '${factoryPath}';
      export default ${moduleName}NgFactory;
  `;
  patchEntryPoint(entryPointContents);

  config.output.filename = `${pluginName}.js`;
  config.output.library = pluginName;
  config.output.libraryTarget = 'umd';
  // workaround to support bundle on nodejs
  config.output.globalObject = `(typeof self !== 'undefined' ? self : this)`;
}

export default createBuilder<JsonObject>(buildPlugin);
//
