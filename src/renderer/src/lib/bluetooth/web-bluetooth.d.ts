/**
 * Web Bluetooth API の最小限の型定義（ambient宣言）。
 *
 * 本プロジェクトのtsconfig.web.jsonが参照するTypeScript DOM libには
 * Web Bluetooth型が含まれていないため、@types/web-bluetooth依存を追加せず
 * 必要な分だけをここで宣言する。接続・切断・指令書き込み（writeValue）まで
 * カバーする。将来的に@types/web-bluetoothを導入した場合は本ファイルは削除してよい。
 *
 * 参考: https://webbluetoothcg.github.io/web-bluetooth/
 */

interface BluetoothRequestDeviceFilter {
  name?: string;
  namePrefix?: string;
  services?: string[] | number[];
}

interface BluetoothRequestDeviceOptions {
  filters?: BluetoothRequestDeviceFilter[];
  optionalServices?: string[] | number[];
  acceptAllDevices?: boolean;
}

interface BluetoothCharacteristicProperties {
  readonly broadcast: boolean;
  readonly read: boolean;
  readonly write: boolean;
  readonly writeWithoutResponse: boolean;
  readonly notify: boolean;
  readonly indicate: boolean;
  readonly authenticatedSignedWrites: boolean;
  readonly reliableWrite: boolean;
  readonly writableAuxiliaries: boolean;
}

interface BluetoothRemoteGATTCharacteristic {
  readonly service: BluetoothRemoteGATTService;
  readonly uuid: string;
  readonly value: DataView | null;
  readonly properties: BluetoothCharacteristicProperties;
  writeValue(data: Uint8Array | ArrayBuffer): Promise<void>;
  writeValueWithResponse(data: Uint8Array | ArrayBuffer): Promise<void>;
  writeValueWithoutResponse(data: Uint8Array | ArrayBuffer): Promise<void>;
  startNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
  stopNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
  addEventListener(
    type: 'characteristicvaluechanged',
    listener: (event: Event) => void
  ): void;
  removeEventListener(
    type: 'characteristicvaluechanged',
    listener: (event: Event) => void
  ): void;
}

interface BluetoothRemoteGATTService {
  readonly device: BluetoothDevice;
  readonly uuid: string;
  getCharacteristic(uuid: string): Promise<BluetoothRemoteGATTCharacteristic>;
  getCharacteristics(uuid?: string): Promise<BluetoothRemoteGATTCharacteristic[]>;
}

interface BluetoothRemoteGATTServer {
  readonly device: BluetoothDevice;
  readonly connected: boolean;
  connect(): Promise<BluetoothRemoteGATTServer>;
  disconnect(): void;
  getPrimaryService(uuid: string): Promise<BluetoothRemoteGATTService>;
  getPrimaryServices(uuid?: string): Promise<BluetoothRemoteGATTService[]>;
}

interface BluetoothDevice {
  readonly id: string;
  readonly name?: string;
  readonly gatt?: BluetoothRemoteGATTServer;
  addEventListener(type: 'gattserverdisconnected', listener: () => void): void;
  removeEventListener(type: 'gattserverdisconnected', listener: () => void): void;
}

interface Bluetooth {
  getAvailability(): Promise<boolean>;
  requestDevice(options?: BluetoothRequestDeviceOptions): Promise<BluetoothDevice>;
}

interface Navigator {
  readonly bluetooth?: Bluetooth;
}
