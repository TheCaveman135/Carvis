import Foundation
import AVFoundation
import CoreAudio
import AudioToolbox

func property(_ device: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String {
    var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var value: Unmanaged<CFString>? = nil
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, &value) == noErr else { return "" }
    return value?.takeUnretainedValue() as String? ?? ""
}
func channels(_ device: AudioObjectID, _ scope: AudioObjectPropertyScope) -> UInt32 {
    var address = AudioObjectPropertyAddress(mSelector:kAudioDevicePropertyStreamConfiguration,mScope:scope,mElement:kAudioObjectPropertyElementMain)
    var size:UInt32=0
    guard AudioObjectGetPropertyDataSize(device,&address,0,nil,&size)==noErr, size>0 else{return 0}
    let raw=UnsafeMutableRawPointer.allocate(byteCount:Int(size),alignment:MemoryLayout<AudioBufferList>.alignment)
    defer{raw.deallocate()}
    guard AudioObjectGetPropertyData(device,&address,0,nil,&size,raw)==noErr else{return 0}
    return UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to:AudioBufferList.self)).reduce(0){$0+$1.mNumberChannels}
}
func devices() -> [[String:Any]] {
    var address=AudioObjectPropertyAddress(mSelector:kAudioHardwarePropertyDevices,mScope:kAudioObjectPropertyScopeGlobal,mElement:kAudioObjectPropertyElementMain)
    var size:UInt32=0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject),&address,0,nil,&size)==noErr else{return []}
    var ids=[AudioObjectID](repeating:0,count:Int(size)/MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject),&address,0,nil,&size,&ids)==noErr else{return []}
    return ids.map { id in ["uid":property(id,kAudioDevicePropertyDeviceUID),"id":id,"name":property(id,kAudioObjectPropertyName),"input":channels(id,kAudioDevicePropertyScopeInput)>0,"output":channels(id,kAudioDevicePropertyScopeOutput)>0] }
}
func fail(_ message:String)->Never {FileHandle.standardError.write(Data((message+"\n").utf8));exit(1)}
let args=CommandLine.arguments
if args.count==2 && args[1]=="list" {
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject:devices()));exit(0)
}
guard args.count==3 && args[1]=="capture" else{fail("Use list or capture <device UID>")}
guard let selected=devices().first(where:{$0["uid"] as? String==args[2] && $0["input"] as? Bool==true}),let id=selected["id"] as? AudioObjectID else{fail("Selected microphone is unavailable")}
let permission=AVCaptureDevice.authorizationStatus(for:.audio)
if permission == .notDetermined {
    let semaphore=DispatchSemaphore(value:0)
    AVCaptureDevice.requestAccess(for:.audio){_ in semaphore.signal()};semaphore.wait()
}
guard AVCaptureDevice.authorizationStatus(for:.audio) == .authorized else{fail("Allow Carvis microphone access in macOS Privacy & Security → Microphone")}
let engine=AVAudioEngine()
let input=engine.inputNode
var device=id
guard let unit=input.audioUnit,AudioUnitSetProperty(unit,kAudioOutputUnitProperty_CurrentDevice,kAudioUnitScope_Global,0,&device,UInt32(MemoryLayout<AudioObjectID>.size))==noErr else{fail("Could not select this microphone")}
// Let the tap negotiate with the selected hardware. The node's cached output
// format may still describe the previous device after CurrentDevice changes.
guard let target=AVAudioFormat(commonFormat:.pcmFormatInt16,sampleRate:16000,channels:1,interleaved:true) else{fail("Unsupported speech format")}
var converter:AVAudioConverter?
input.installTap(onBus:0,bufferSize:2048,format:nil){buffer,_ in
    let format=buffer.format
    guard format.sampleRate>0,format.channelCount>0 else{return}
    // Build from the actual delivered buffer, including changes of device rate.
    if converter == nil || !converter!.inputFormat.isEqual(format) {
        converter=AVAudioConverter(from:format,to:target)
    }
    guard let converter=converter else{return}
    let capacity=AVAudioFrameCount(ceil(Double(buffer.frameLength)*16000/format.sampleRate)+16)
    guard let output=AVAudioPCMBuffer(pcmFormat:target,frameCapacity:capacity) else{return}
    var supplied=false;var error:NSError?
    converter.convert(to:output,error:&error){_,status in
        if supplied{status.pointee = .noDataNow;return nil}
        supplied=true;status.pointee = .haveData;return buffer
    }
    if error==nil,let bytes=output.int16ChannelData?[0],output.frameLength>0{FileHandle.standardOutput.write(Data(bytes:bytes,count:Int(output.frameLength)*2))}
}
do{try engine.start()}catch{fail("Microphone could not start: \(error.localizedDescription)")}
let parent = getppid()
let watchdog = Timer.scheduledTimer(withTimeInterval:1,repeats:true){_ in if getppid() != parent { engine.stop(); exit(0) }}
RunLoop.main.run()
