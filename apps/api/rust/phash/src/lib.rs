//! Rust port of `apps/api/src/phash.ts` for the wasm experiment. The math
//! mirrors the TS step for step so both produce the same hash: equality is
//! the only match the classifier uses.

const SAMPLE: usize = 32;
const LOW: usize = 8;
const MAX_PIXELS: usize = 9_000_000;

pub const KIND_PNG: u32 = 1;
pub const KIND_JPEG: u32 = 2;

/// Interleaved 8-bit pixels with 1 (gray), 2 (gray+alpha), 3 (RGB) or 4 (RGBA) channels.
struct Frame {
    data: Vec<u8>,
    width: usize,
    height: usize,
    channels: usize,
}

/// The 63-bit hash, or `None` when the bytes do not decode.
pub fn image_phash(bytes: &[u8], kind: u32) -> Option<u64> {
    let frame = match kind {
        KIND_PNG => decode_png(bytes)?,
        KIND_JPEG => decode_jpeg(bytes)?,
        _ => return None,
    };
    if frame.width == 0 || frame.height == 0 || frame.width * frame.height > MAX_PIXELS {
        return None;
    }
    Some(dct_phash(&frame))
}

/// Matches pngjs: 16-bit samples round to 8 bits, and a tRNS color key
/// zeroes the whole pixel (RGB too, not only alpha).
fn decode_png(bytes: &[u8]) -> Option<Frame> {
    let mut decoder = png::Decoder::new(bytes);
    decoder.set_transformations(png::Transformations::EXPAND);
    let mut reader = decoder.read_info().ok()?;
    let keyed = {
        let info = reader.info();
        info.trns.is_some() && info.color_type != png::ColorType::Indexed
    };
    let mut data = vec![0; reader.output_buffer_size()];
    let info = reader.next_frame(&mut data).ok()?;
    data.truncate(info.buffer_size());
    let channels = match info.color_type {
        png::ColorType::Grayscale => 1,
        png::ColorType::GrayscaleAlpha => 2,
        png::ColorType::Rgb => 3,
        png::ColorType::Rgba => 4,
        png::ColorType::Indexed => return None,
    };
    if info.bit_depth == png::BitDepth::Sixteen {
        data = data
            .chunks_exact(2)
            .map(|s| {
                let v = u16::from_be_bytes([s[0], s[1]]) as f64;
                (v * 255.0 / 65535.0 + 0.5).floor() as u8
            })
            .collect();
    }
    if keyed {
        for px in data.chunks_exact_mut(channels) {
            if px[channels - 1] == 0 {
                px.fill(0);
            }
        }
    }
    Some(Frame { data, width: info.width as usize, height: info.height as usize, channels })
}

fn decode_jpeg(bytes: &[u8]) -> Option<Frame> {
    let mut decoder = jpeg_decoder::Decoder::new(bytes);
    decoder.set_max_decoding_buffer_size(MAX_PIXELS * 4);
    let data = decoder.decode().ok()?;
    let info = decoder.info()?;
    let channels = match info.pixel_format {
        jpeg_decoder::PixelFormat::L8 => 1,
        jpeg_decoder::PixelFormat::RGB24 => 3,
        _ => return None,
    };
    Some(Frame { data, width: info.width as usize, height: info.height as usize, channels })
}

/// Box-average to 32×32, DCT-II, median of the 63 AC coefficients.
fn dct_phash(frame: &Frame) -> u64 {
    let (width, height, ch) = (frame.width, frame.height, frame.channels);
    let color = ch >= 3;
    let mut gray = [0f64; SAMPLE * SAMPLE];
    for y in 0..SAMPLE {
        let y0 = y * height / SAMPLE;
        let y1 = ((y + 1) * height / SAMPLE).max(y0 + 1).min(height);
        for x in 0..SAMPLE {
            let x0 = x * width / SAMPLE;
            let x1 = ((x + 1) * width / SAMPLE).max(x0 + 1).min(width);
            let mut sum = 0f64;
            let mut count = 0u32;
            for yy in y0..y1 {
                let row = yy * width;
                for xx in x0..x1 {
                    let i = (row + xx) * ch;
                    let (r, g, b) = if color {
                        (frame.data[i], frame.data[i + 1], frame.data[i + 2])
                    } else {
                        (frame.data[i], frame.data[i], frame.data[i])
                    };
                    sum += r as f64 * 0.299 + g as f64 * 0.587 + b as f64 * 0.114;
                    count += 1;
                }
            }
            gray[y * SAMPLE + x] = if count == 0 { 0.0 } else { sum / count as f64 };
        }
    }

    let scale = core::f64::consts::PI / (2 * SAMPLE) as f64;
    let mut cos = [0f64; SAMPLE * SAMPLE];
    for k in 0..SAMPLE {
        for n in 0..SAMPLE {
            cos[k * SAMPLE + n] = (((2 * n + 1) * k) as f64 * scale).cos();
        }
    }
    let mut rows = [0f64; SAMPLE * SAMPLE];
    for y in 0..SAMPLE {
        for u in 0..SAMPLE {
            let mut sum = 0f64;
            for x in 0..SAMPLE {
                sum += gray[y * SAMPLE + x] * cos[u * SAMPLE + x];
            }
            rows[y * SAMPLE + u] = sum;
        }
    }
    let mut coeffs = Vec::with_capacity(LOW * LOW - 1);
    for v in 0..LOW {
        for u in 0..LOW {
            if u == 0 && v == 0 {
                continue;
            }
            let mut sum = 0f64;
            for y in 0..SAMPLE {
                sum += rows[y * SAMPLE + u] * cos[v * SAMPLE + y];
            }
            coeffs.push(sum);
        }
    }
    let mut sorted = coeffs.clone();
    sorted.sort_by(|a, b| a.total_cmp(b));
    let median = sorted[31];
    let mut bits = 0u64;
    for (i, c) in coeffs.iter().enumerate() {
        if *c > median {
            bits |= 1 << i;
        }
    }
    bits
}

// Wasm ABI: the host copies the bytes into `alloc`, then calls `phash`.
// A fresh instance per call keeps decode memory from pinning the isolate.

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(len);
    let ptr = buf.as_mut_ptr();
    core::mem::forget(buf);
    ptr
}

/// The hash as a non-negative i64, or -1 when the bytes do not decode.
#[no_mangle]
pub extern "C" fn phash(ptr: *mut u8, len: usize, kind: u32) -> i64 {
    let bytes = unsafe { Vec::from_raw_parts(ptr, len, len) };
    image_phash(&bytes, kind).map_or(-1, |h| h as i64)
}
