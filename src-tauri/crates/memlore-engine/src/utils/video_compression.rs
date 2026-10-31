//! Optional video compression applied before media files land in the media
//! directory. Reduces the on-disk + sync footprint of clips coming in from the
//! Photo Library or file picker by transcoding them to H.264 + AAC `.mp4` at a
//! downscaled resolution.
//!
//! Unlike image compression (which runs in-process via the `image` crate), the
//! actual transcode is delegated to macOS AVFoundation (`AVAssetExportSession`)
//! through the swift-rs bridge — VideoToolbox provides the H.264 encoder, so no
//! codec is bundled and there is no GPL / patent-royalty exposure. This module
//! is the pure, platform-independent policy layer: it maps the user's Settings
//! choice to an AVFoundation resolution preset name. The actual FFI call and
//! the "only keep it if it's smaller" guard live in the media command.

/// Compression preset chosen via Settings. The frontend writes one of these
/// strings to the `video_compression_mode` setting; `from_settings` does the
/// conversion. Default `Standard` matches the most common phone-clip case.
///
/// Mirrors `image_compression::CompressionMode`, but video "quality" is baked
/// into the AVFoundation resolution preset — there is no separate quality knob,
/// so `Custom` carries only a `max_edge` that selects the nearest preset.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VideoCompressionMode {
    /// Pass every video through unchanged. Original bytes go to disk.
    Off,
    /// Downscale to 960 × 540 (qHD). Sensible default for journal clips.
    Standard,
    /// Downscale to 640 × 480. Heavier squeeze for sync-bandwidth constrained
    /// users.
    Aggressive,
    /// User-provided max edge from Settings, mapped to the nearest preset.
    Custom { max_edge: u32 },
}

impl VideoCompressionMode {
    pub fn from_settings(mode: &str, edge: Option<u32>) -> Self {
        match mode.trim().to_lowercase().as_str() {
            "off" => Self::Off,
            "aggressive" => Self::Aggressive,
            "custom" => Self::Custom {
                max_edge: edge.unwrap_or(960).clamp(240, 3840),
            },
            // Default: "standard" or any unknown / empty value
            _ => Self::Standard,
        }
    }

    /// AVFoundation `AVAssetExportPreset*` name the export session should use,
    /// or `None` when no transcode should run (`Off`). These presets all encode
    /// H.264 video + AAC audio and preserve aspect ratio (the frame is fit
    /// inside the named box, never upscaled by the encoder).
    ///
    /// `Custom` picks the smallest preset whose long edge is >= the requested
    /// `max_edge`, so a larger request keeps more detail while a request below
    /// the floor still lands on the smallest preset.
    pub fn preset_name(&self) -> Option<&'static str> {
        match self {
            Self::Off => None,
            Self::Standard => Some("AVAssetExportPreset960x540"),
            Self::Aggressive => Some("AVAssetExportPreset640x480"),
            Self::Custom { max_edge } => Some(preset_for_max_edge(*max_edge)),
        }
    }
}

/// Preset long edges, ascending. Kept in sync with the returned names below.
const PRESET_LADDER: [(u32, &str); 4] = [
    (480, "AVAssetExportPreset640x480"),
    (540, "AVAssetExportPreset960x540"),
    (720, "AVAssetExportPreset1280x720"),
    (1080, "AVAssetExportPreset1920x1080"),
];

/// Smallest preset whose long edge is >= `max_edge`; the largest preset when
/// `max_edge` exceeds every rung.
fn preset_for_max_edge(max_edge: u32) -> &'static str {
    for (edge, name) in PRESET_LADDER {
        if max_edge <= edge {
            return name;
        }
    }
    PRESET_LADDER[PRESET_LADDER.len() - 1].1
}
