"""Print the OpenCV camera index gaze.py should use.

On a Mac, a nearby iPhone shows up as a Continuity Camera and can take
index 0, so the eye tracker would watch the phone instead of the student.
OpenCV's AVFoundation backend numbers cameras in the order that
AVCaptureDevice.devicesWithMediaType returns them (video, then muxed), so we
list them the same way and pick the built-in webcam. iPhones are never picked.

    python tools/pick_camera.py            # built-in camera
    python tools/pick_camera.py facetime   # first camera whose name contains this

Prints 0 when not on macOS or when PyObjC isn't installed. The chosen camera
is reported on stderr (run.sh sends it to .logs/gaze.log).
"""
import sys


def main():
    prefer = sys.argv[1].lower() if len(sys.argv) > 1 else None
    try:
        import AVFoundation as AV
    except ImportError:
        print(0)
        return

    devices = list(AV.AVCaptureDevice.devicesWithMediaType_(AV.AVMediaTypeVideo)) + list(
        AV.AVCaptureDevice.devicesWithMediaType_(AV.AVMediaTypeMuxed)
    )
    names = [str(d.localizedName()) for d in devices]
    kinds = [str(d.deviceType()) for d in devices]
    is_phone = [("iphone" in n.lower() or "Continuity" in k) for n, k in zip(names, kinds)]

    choice = None
    if prefer:
        choice = next((i for i, n in enumerate(names) if prefer in n.lower()), None)
    if choice is None:  # the Mac's own webcam
        choice = next((i for i, k in enumerate(kinds) if k.endswith("BuiltInWideAngleCamera")), None)
    if choice is None:  # an external webcam, but never a phone
        choice = next((i for i in range(len(devices)) if not is_phone[i]), 0)

    listing = ", ".join(f"{i}={n}" for i, n in enumerate(names)) or "none found"
    print(f"cameras: {listing} -> using {choice}", file=sys.stderr)
    print(choice)


if __name__ == "__main__":
    main()
