//! Ports of `poster-overlay.ts` and the PDF preview's JPEG encode. The
//! composite mirrors the TS step for step; the encoder is jpeg-encoder at
//! 4:4:4, the same subsampling jpeg-js writes.

use jpeg_encoder::{ColorType, Encoder, SamplingFactor};

/// `PLAY_BUTTON_DIAMETER_RATIO` in poster-overlay.ts.
const PLAY_BUTTON_DIAMETER_RATIO: f64 = 0.22;
const PLAY_BUTTON_JPEG_QUALITY: u8 = 85;
const MIN_EDGE_PX: usize = 32;
/// jpeg-js `maxResolutionInMP: 8` in the TS overlay.
const MAX_POSTER_PIXELS: usize = 8_000_000;

/// Same 256×256 PNG as `playButtonPng()`; a test checks they are equal.
static PLAY_BUTTON_PNG: &[u8] = include_bytes!("../assets/play-button.png");

struct Rgba {
    data: Vec<u8>,
    width: usize,
    height: usize,
}

pub fn encode_rgba(rgba: &[u8], width: usize, height: usize, quality: u8) -> Option<Vec<u8>> {
    if width == 0 || height == 0 || width > u16::MAX as usize || height > u16::MAX as usize {
        return None;
    }
    if rgba.len() != width * height * 4 {
        return None;
    }
    let mut out = Vec::new();
    let mut encoder = Encoder::new(&mut out, quality);
    encoder.set_sampling_factor(SamplingFactor::R_4_4_4);
    encoder
        .encode(rgba, width as u16, height as u16, ColorType::Rgba)
        .ok()?;
    Some(out)
}

/// Decode `jpeg`, center the play button, and re-encode at quality 85.
pub fn overlay_play_button(jpeg: &[u8]) -> Option<Vec<u8>> {
    let mut img = decode_jpeg_rgba(jpeg)?;
    if img.width.min(img.height) >= MIN_EDGE_PX {
        let sprite = decode_sprite()?;
        let size = (img.width.min(img.height) as f64 * PLAY_BUTTON_DIAMETER_RATIO).round() as i64;
        composite_centered(&mut img, &sprite, size);
    }
    encode_rgba(&img.data, img.width, img.height, PLAY_BUTTON_JPEG_QUALITY)
}

fn decode_jpeg_rgba(bytes: &[u8]) -> Option<Rgba> {
    let mut decoder = jpeg_decoder::Decoder::new(bytes);
    decoder.set_max_decoding_buffer_size(MAX_POSTER_PIXELS * 4);
    let pixels = decoder.decode().ok()?;
    let info = decoder.info()?;
    let (width, height) = (info.width as usize, info.height as usize);
    if width * height > MAX_POSTER_PIXELS {
        return None;
    }
    let mut data = vec![255u8; width * height * 4];
    match info.pixel_format {
        jpeg_decoder::PixelFormat::RGB24 => {
            for (src, dst) in pixels.chunks_exact(3).zip(data.chunks_exact_mut(4)) {
                dst[..3].copy_from_slice(src);
            }
        }
        jpeg_decoder::PixelFormat::L8 => {
            for (v, dst) in pixels.iter().zip(data.chunks_exact_mut(4)) {
                dst[..3].fill(*v);
            }
        }
        _ => return None,
    }
    Some(Rgba {
        data,
        width,
        height,
    })
}

fn decode_sprite() -> Option<Rgba> {
    let decoder = png::Decoder::new(PLAY_BUTTON_PNG);
    let mut reader = decoder.read_info().ok()?;
    let mut data = vec![0; reader.output_buffer_size()];
    let info = reader.next_frame(&mut data).ok()?;
    if info.color_type != png::ColorType::Rgba || info.bit_depth != png::BitDepth::Eight {
        return None;
    }
    Some(Rgba {
        data,
        width: info.width as usize,
        height: info.height as usize,
    })
}

fn composite_centered(dest: &mut Rgba, sprite: &Rgba, size: i64) {
    if size < 1 {
        return;
    }
    let (dw, dh) = (dest.width as i64, dest.height as i64);
    let x0 = ((dw - size) as f64 / 2.0).round() as i64;
    let y0 = ((dh - size) as f64 / 2.0).round() as i64;
    for y in 0..size {
        let dy = y0 + y;
        if dy < 0 || dy >= dh {
            continue;
        }
        let sy = ((y as f64 + 0.5) * sprite.height as f64) / size as f64 - 0.5;
        for x in 0..size {
            let dx = x0 + x;
            if dx < 0 || dx >= dw {
                continue;
            }
            let sx = ((x as f64 + 0.5) * sprite.width as f64) / size as f64 - 0.5;
            let [r, g, b, a] = sample_bilinear(sprite, sx, sy);
            if a <= 0.0 {
                continue;
            }
            let i = ((dy * dw + dx) * 4) as usize;
            let aa = a / 255.0;
            let inv = 1.0 - aa;
            dest.data[i] = (dest.data[i] as f64 * inv + r * aa) as u8;
            dest.data[i + 1] = (dest.data[i + 1] as f64 * inv + g * aa) as u8;
            dest.data[i + 2] = (dest.data[i + 2] as f64 * inv + b * aa) as u8;
        }
    }
}

fn sample_bilinear(sprite: &Rgba, sx: f64, sy: f64) -> [f64; 4] {
    let x0 = sx.floor() as i64;
    let y0 = sy.floor() as i64;
    let fx = sx - x0 as f64;
    let fy = sy - y0 as f64;
    let c00 = px(sprite, x0, y0);
    let c10 = px(sprite, x0 + 1, y0);
    let c01 = px(sprite, x0, y0 + 1);
    let c11 = px(sprite, x0 + 1, y0 + 1);
    let mut out = [0f64; 4];
    for k in 0..4 {
        out[k] = lerp(lerp(c00[k], c10[k], fx), lerp(c01[k], c11[k], fx), fy);
    }
    out
}

fn px(sprite: &Rgba, x: i64, y: i64) -> [f64; 4] {
    let xx = x.clamp(0, sprite.width as i64 - 1) as usize;
    let yy = y.clamp(0, sprite.height as i64 - 1) as usize;
    let i = (yy * sprite.width + xx) * 4;
    let d = &sprite.data;
    [
        d[i] as f64,
        d[i + 1] as f64,
        d[i + 2] as f64,
        d[i + 3] as f64,
    ]
}

fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}
