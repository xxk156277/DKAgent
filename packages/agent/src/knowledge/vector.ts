/**
 * 将数值向量编码为紧凑的 Float32 BLOB，供 SQLite 保存。
 */
export function encodeVector(vector: number[]): Buffer {
    if (vector.length === 0) {
        throw new Error("Embedding 向量不能为空");
    }
    if (vector.some((value) => !Number.isFinite(value))) {
        throw new Error("Embedding 向量只能包含有限数字");
    }

    const values = Float32Array.from(vector);
    return Buffer.from(values.buffer, values.byteOffset, values.byteLength);
}

/**
 * 将 SQLite 中的 Float32 BLOB 解码为普通数组。
 */
export function decodeVector(value: Buffer, dimensions: number): number[] {
    const expectedBytes = dimensions * Float32Array.BYTES_PER_ELEMENT;
    if (!Number.isInteger(dimensions) || dimensions <= 0) {
        throw new Error("Embedding 维度必须是正整数");
    }
    if (value.byteLength !== expectedBytes) {
        throw new Error(`Embedding 字节长度错误：期望 ${expectedBytes}，实际 ${value.byteLength}`);
    }

    // 复制 Buffer，避免底层 byteOffset 未按 Float32 对齐导致构造失败。
    const copied = Uint8Array.from(value);
    return Array.from(new Float32Array(copied.buffer));
}
