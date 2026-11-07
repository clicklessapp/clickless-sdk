/**
 * Sets an entry that is the record's own, whatever it is called. Assigning to
 * the name `__proto__` would change what the record inherits from instead of
 * adding an entry, and components and props are named by developers.
 */
export function setOwnProperty<T>(record: Record<string, T>, propertyName: string, propertyValue: T): void {
  Object.defineProperty(record, propertyName, { value: propertyValue, enumerable: true, writable: true, configurable: true });
}

/**
 * What a record holds under a property name, leaving out what every object inherits: a
 * prop named "constructor" or "toString" is absent unless the record has it.
 */
export function ownPropertyValue<T>(record: Record<string, T> | undefined, propertyName: string): T | undefined {
  return record !== undefined && Object.hasOwn(record, propertyName) ? record[propertyName] : undefined;
}
