// 軽量化のためのFFMPEG最適化設定
module.exports = {
  // サムネイル生成の最適化
  thumbnailSettings: {
    quality: 3, // 品質を下げる（1-31の範囲、数字が大きいほど低品質）
    scale: 'scale=320:-1', // より小さなサムネイル
    format: 'jpg', // jpegの方がpngより軽い
    compression: 'medium'
  },
  
  // FFMPEGコマンドの最適化
  ffmpegOptimization: {
    // 不要なメタデータの除去
    removeMetadata: true,
    // より速い処理のための設定
    preset: 'ultrafast',
    // ハードウェアアクセラレーション（可能な場合）
    hwaccel: 'auto'
  }
};
