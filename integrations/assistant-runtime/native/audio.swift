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
// AVCaptureSession negotiates the selected microphone independently of the
// system output device, including Bluetooth headset sample-rate transitions.
final class AudioReceiver:NSObject,AVCaptureAudioDataOutputSampleBufferDelegate {
    let target=AVAudioFormat(commonFormat:.pcmFormatInt16,sampleRate:16000,channels:1,interleaved:true)!
    var converter:AVAudioConverter?
    func captureOutput(_ output:AVCaptureOutput,didOutput sample:CMSampleBuffer,from connection:AVCaptureConnection) {
        guard let description=CMSampleBufferGetFormatDescription(sample) else{return}
        let format=AVAudioFormat(cmAudioFormatDescription:description)
        let frames=CMSampleBufferGetNumSamples(sample)
        guard frames>0,format.sampleRate>0,let buffer=AVAudioPCMBuffer(pcmFormat:format,frameCapacity:AVAudioFrameCount(frames)) else{return}
        buffer.frameLength=AVAudioFrameCount(frames)
        guard CMSampleBufferCopyPCMDataIntoAudioBufferList(sample,at:0,frameCount:Int32(frames),into:buffer.mutableAudioBufferList)==noErr else{return}
        if converter == nil || !converter!.inputFormat.isEqual(format){converter=AVAudioConverter(from:format,to:target)}
        guard let converter=converter,let converted=AVAudioPCMBuffer(pcmFormat:target,frameCapacity:AVAudioFrameCount(ceil(Double(frames)*16000/format.sampleRate)+16)) else{return}
        var supplied=false;var error:NSError?
        converter.convert(to:converted,error:&error){_,status in
            if supplied{status.pointee = .noDataNow;return nil}
            supplied=true;status.pointee = .haveData;return buffer
        }
        if error==nil,let bytes=converted.int16ChannelData?[0],converted.frameLength>0 {
            FileHandle.standardOutput.write(Data(bytes:bytes,count:Int(converted.frameLength)*2))
        }
    }
}
guard let microphone=AVCaptureDevice(uniqueID:args[2]),microphone.hasMediaType(.audio) else{fail("Selected microphone is unavailable for capture")}
let session=AVCaptureSession()
let receiver=AudioReceiver()
let output=AVCaptureAudioDataOutput()
output.setSampleBufferDelegate(receiver,queue:DispatchQueue(label:"app.carvis.audio"))
session.beginConfiguration()
do {
    let input=try AVCaptureDeviceInput(device:microphone)
    guard session.canAddInput(input),session.canAddOutput(output) else{fail("Selected microphone cannot be opened")}
    session.addInput(input);session.addOutput(output)
}catch{fail("Microphone could not open: \(error.localizedDescription)")}
session.commitConfiguration()
let errors=NotificationCenter.default.addObserver(forName:.AVCaptureSessionRuntimeError,object:session,queue:nil){notification in
    let error=notification.userInfo?[AVCaptureSessionErrorKey] as? NSError
    fail("Microphone stopped: \(error?.localizedDescription ?? "capture error")")
}
session.startRunning()
guard session.isRunning else{fail("Microphone could not start")}
let parent=getppid()
let watchdog=Timer.scheduledTimer(withTimeInterval:1,repeats:true){_ in if getppid() != parent {session.stopRunning();exit(0)}}
RunLoop.main.run()
