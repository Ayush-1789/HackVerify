// @ts-ignore
import pdf from 'pdf-parse/lib/pdf-parse.js';

export async function parsePdfBuffer(buffer: Buffer): Promise<string> {
  console.log('DEBUG: parsePdfBuffer called with buffer size:', buffer.length);
  try {
    const data = await pdf(buffer);
    console.log('DEBUG: Successfully parsed PDF using classic pdf-parse core');
    return data.text || '';
  } catch (error) {
    if (error instanceof Error) {
      console.error('DEBUG: PDF parse error stack:', error.stack);
    } else {
      console.error('DEBUG: PDF parse error:', error);
    }
    throw new Error(`Failed to parse PDF statements: ${error instanceof Error ? error.message : String(error)}`);
  }
}
