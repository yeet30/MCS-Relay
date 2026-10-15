import './startup-progress.css'
import { useState, useEffect } from 'react';
import { Loader2, Check, X } from 'lucide-react';
import Modal from '../modal';
import ProgressModal from '../progress-modal';

type ProgressStep = {
    message: string;
    status: 'loading' | 'done' | 'error';
    importance: 'major' | 'minor';
}

export default function StartupProgress(){

    const [isModalOpen, setIsModalOpen] = useState(false)

    const [minorStep, setMinorStep] = useState<ProgressStep>({
        message: "",
        status: "loading",
        importance: "minor"
    });
    const [majorStep, setMajorStep] = useState<ProgressStep>({
        message: "",
        status: "loading",
        importance: "major"
    })

    useEffect(() => {
        window.ipcRenderer.on("startup-progress", (_, step: ProgressStep) => {
            if(step.importance === "minor")
                setMinorStep(step);
            else 
                setMajorStep(step)
        });
    }, []);

    return (
        <div className="startup-progress">
            <Modal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} items={[{
                    title: "Progress Details",
                    content: <ProgressModal/>
                }
            ]}
            />
            {majorStep.message &&
                <div className={`progress-step ${majorStep.status} ${majorStep.importance}`}>
                    {majorStep.status === 'loading' && <Loader2 size={12} className="spinner"/>}
                    {majorStep.status === 'done' && <Check size={12}/>}
                    {majorStep.status === 'error' && <X size={12}/>}
                    <span>{majorStep.message}</span>
                </div>
            }
            <button className='details-button' onClick={()=>{setIsModalOpen(true)}}>
                Show detailed progress
            </button>
            {minorStep.message &&
                <div className={`progress-step ${minorStep.status} ${minorStep.importance}`}>
                    {minorStep.status === 'loading' && <Loader2 size={12} className="spinner"/>}
                    {minorStep.status === 'done' && <Check size={12}/>}
                    {minorStep.status === 'error' && <X size={12}/>}
                    <span>{minorStep.message}</span>
                </div>
            }
        </div>
    )
}