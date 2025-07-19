// webpack.config.js - 必要に応じてレンダラープロセスの最適化
const path = require("path");

module.exports = {
  mode: "production",
  entry: "./src/renderer/app.js",
  target: "electron-renderer",
  optimization: {
    minimize: true,
    usedExports: true,
    sideEffects: false,
  },
  resolve: {
    extensions: [".js"],
  },
  module: {
    rules: [
      {
        test: /\.js$/,
        exclude: /node_modules/,
        use: {
          loader: "babel-loader",
          options: {
            presets: ["@babel/preset-env"],
          },
        },
      },
    ],
  },
};
