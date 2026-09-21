//! sidecar のプロセスツリーをアプリの寿命に合わせて管理する。

#[cfg(not(windows))]
use tauri::async_runtime::Receiver;
#[cfg(not(windows))]
use tauri_plugin_shell::process::{Command, CommandEvent};

#[cfg(not(windows))]
pub struct ManagedChild(tauri_plugin_shell::process::CommandChild);

#[cfg(not(windows))]
pub fn spawn(command: Command) -> Result<(Receiver<CommandEvent>, ManagedChild), String> {
    command
        .spawn()
        .map(|(events, child)| (events, ManagedChild(child)))
        .map_err(|error| error.to_string())
}

#[cfg(not(windows))]
impl ManagedChild {
    pub fn kill(self) -> Result<(), String> {
        self.0.kill().map_err(|error| error.to_string())
    }
}

#[cfg(windows)]
mod windows {
    use std::io::{BufRead, BufReader, Read};
    use std::mem::size_of;
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::CommandExt;
    use std::process::{Child, Command as StdCommand};
    use std::ptr::null;
    use std::sync::Arc;
    use std::thread;

    use tauri::async_runtime::{block_on, channel, Receiver, Sender};
    use tauri_plugin_shell::process::{Command, CommandEvent, TerminatedPayload};
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        OpenThread, ResumeThread, CREATE_NO_WINDOW, CREATE_SUSPENDED, THREAD_SUSPEND_RESUME,
    };

    pub struct ManagedChild(Arc<WindowsJob>);

    pub fn spawn(command: Command) -> Result<(Receiver<CommandEvent>, ManagedChild), String> {
        let job = Arc::new(WindowsJob::new()?);
        let mut command: StdCommand = command.into();
        command.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);

        let mut child = command
            .spawn()
            .map_err(|error| format!("sidecarを開始できませんでした: {error}"))?;
        if let Err(error) = job.assign(&child).and_then(|()| resume(&child)) {
            terminate(&mut child);
            return Err(error);
        }

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "sidecarの標準出力を取得できませんでした".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "sidecarの標準エラーを取得できませんでした".to_string())?;
        let (sender, receiver) = channel(1);
        let stdout_thread = read_lines(stdout, sender.clone(), CommandEvent::Stdout);
        let stderr_thread = read_lines(stderr, sender.clone(), CommandEvent::Stderr);
        let wait_job = Arc::clone(&job);

        thread::spawn(move || {
            let status = child.wait();
            // PyInstallerの親だけが終了しても、子がpipeを保持したまま残らないようにする。
            let _ = wait_job.terminate();
            let _ = stdout_thread.join();
            let _ = stderr_thread.join();
            let event = match status {
                Ok(status) => CommandEvent::Terminated(TerminatedPayload {
                    code: status.code(),
                    signal: None,
                }),
                Err(error) => CommandEvent::Error(error.to_string()),
            };
            let _ = block_on(sender.send(event));
        });

        Ok((receiver, ManagedChild(job)))
    }

    impl ManagedChild {
        pub fn kill(self) -> Result<(), String> {
            self.0.terminate()
        }
    }

    struct WindowsJob(HANDLE);

    // HANDLE は所有権を持つ不透明な値で、CloseHandle まで別スレッドへ移動できる。
    unsafe impl Send for WindowsJob {}
    unsafe impl Sync for WindowsJob {}

    impl WindowsJob {
        fn new() -> Result<Self, String> {
            let handle = unsafe { CreateJobObjectW(null(), null()) };
            if handle.is_null() {
                return Err(last_error("Windows Job Objectを作成できませんでした"));
            }
            let job = Self(handle);
            let mut information = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let configured = unsafe {
                SetInformationJobObject(
                    job.0,
                    JobObjectExtendedLimitInformation,
                    (&information as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };
            if configured == 0 {
                return Err(last_error("Windows Job Objectを設定できませんでした"));
            }
            Ok(job)
        }

        fn assign(&self, child: &Child) -> Result<(), String> {
            let process = child.as_raw_handle() as HANDLE;
            if unsafe { AssignProcessToJobObject(self.0, process) } == 0 {
                return Err(last_error(
                    "sidecarをWindows Job Objectへ所属させられませんでした",
                ));
            }
            Ok(())
        }

        fn terminate(&self) -> Result<(), String> {
            if unsafe { TerminateJobObject(self.0, 1) } == 0 {
                return Err(last_error("sidecarのプロセスツリーを停止できませんでした"));
            }
            Ok(())
        }
    }

    impl Drop for WindowsJob {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    fn resume(child: &Child) -> Result<(), String> {
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(last_error("sidecarのスレッド一覧を取得できませんでした"));
        }
        let snapshot = OwnedHandle(snapshot);
        let mut entry = THREADENTRY32 {
            dwSize: size_of::<THREADENTRY32>() as u32,
            ..Default::default()
        };
        let mut has_entry = unsafe { Thread32First(snapshot.0, &mut entry) } != 0;
        while has_entry {
            if entry.th32OwnerProcessID == child.id() {
                let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
                if thread.is_null() {
                    return Err(last_error("sidecarの初期スレッドを開けませんでした"));
                }
                let thread = OwnedHandle(thread);
                if unsafe { ResumeThread(thread.0) } == u32::MAX {
                    return Err(last_error("sidecarの初期スレッドを再開できませんでした"));
                }
                return Ok(());
            }
            has_entry = unsafe { Thread32Next(snapshot.0, &mut entry) } != 0;
        }
        Err("sidecarの初期スレッドが見つかりませんでした".to_string())
    }

    struct OwnedHandle(HANDLE);

    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    fn read_lines<R, F>(reader: R, sender: Sender<CommandEvent>, event: F) -> thread::JoinHandle<()>
    where
        R: Read + Send + 'static,
        F: Fn(Vec<u8>) -> CommandEvent + Send + 'static,
    {
        thread::spawn(move || {
            let mut reader = BufReader::new(reader);
            loop {
                let mut bytes = Vec::new();
                match reader.read_until(b'\n', &mut bytes) {
                    Ok(0) => break,
                    Ok(_) => {
                        if block_on(sender.send(event(bytes))).is_err() {
                            break;
                        }
                    }
                    Err(error) => {
                        let _ = block_on(sender.send(CommandEvent::Error(error.to_string())));
                        break;
                    }
                }
            }
        })
    }

    fn terminate(child: &mut Child) {
        let _ = child.kill();
        let _ = child.wait();
    }

    fn last_error(context: &str) -> String {
        format!("{context}: {}", std::io::Error::last_os_error())
    }
}

#[cfg(windows)]
pub use windows::{spawn, ManagedChild};
