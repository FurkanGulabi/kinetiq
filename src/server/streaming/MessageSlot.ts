/**
 * A single-value holder (was src/server/cnc/lib/MessageSlot.js, CNCjs).
 * GrblController puts the %msg / M0 comment here and takes it when the pause is reported.
 */
class MessageSlot<T = unknown> {
  value: T | null = null;

  // Stores a value in the holder.
  put(value: T): void {
    this.value = value;
  }

  // Retrieves and clears the current value, or returns the default if no value is set.
  take(defaultValue: T | null = null): T | null {
    const value = this.value ?? defaultValue;
    this.value = null;
    return value;
  }
}

export default MessageSlot;
