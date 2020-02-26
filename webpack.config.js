const path = require("path");
const fs = require("fs");
const webpack = require("webpack");
const ForkTsCheckerWebpackPlugin = require("fork-ts-checker-webpack-plugin");
const { CleanWebpackPlugin } = require("clean-webpack-plugin");
const CopyPlugin = require("copy-webpack-plugin")

module.exports = (env, argv) => {
  const config = {
    mode: "production",
    entry: ["./src/index.tsx"],
    target: "node",
    output: {
      path: path.resolve(__dirname, "dist"),
      filename: "index.js"
    },
    node: {
      __dirname: false,
      __filename: false
    },
    module: {
      rules: [
        {
          test: /\.(j|t)sx?$/,
          exclude: /node_modules/,
          use: {
            loader: "babel-loader",
            options: { cacheDirectory: true, cacheCompression: false }
          }
        },
        {
          test: /\.(png|jpe?g|gif|svg|bmp|otf)$/i,
          use: [{
            loader: "file-loader",
            options: {
              publicPath: "dist"
            }
          }]
        },
        {
          test: /\.node/i,
          use: [
            {
              loader: "native-addon-loader",
              options: {
                name: "[name]-[hash].[ext]"
              }
            }
          ]
        }
      ]
    },
    plugins: [],
    resolve: {
      extensions: [".tsx", ".ts", ".js", ".jsx", ".json"]
    }
  };

  if (argv.mode === "development") {
    config.mode = "development";
    config.plugins.push(new webpack.HotModuleReplacementPlugin());
    config.plugins.push(new ForkTsCheckerWebpackPlugin());
    config.devtool = "source-map";
    config.watch = true;
    config.entry.unshift("webpack/hot/poll?100");
  }

  if (argv.mode === "production") {
    config.plugins.push(new CopyPlugin([
      { from: 'node', to: 'node' },
    ]),)
  }

  if (argv.p) {
    config.plugins.push(new CleanWebpackPlugin());
  }

  config.plugins.push(function () {
    this.plugin("done", () => {
      fs.chmodSync("dist/node/myst", "755")
      fs.chmodSync("dist/node/config/update-resolv-conf", "755")
    })
  })
  return config;
};
